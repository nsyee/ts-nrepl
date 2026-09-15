import { connect, type NReplClient } from './client.ts';
import { DEFAULT_PORT } from './server.ts';
import type { NReplResponse } from './types.ts';

// ---------------------------------------------------------------------------
// JSON-RPC framing (Content-Length header + UTF-8 JSON body)
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string | null;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const HEADER_SEPARATOR = '\r\n\r\n';

export const encodeMessage = (msg: JsonRpcMessage): Buffer => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`, 'ascii'),
    body,
  ]);
};

/**
 * Split off every complete message at the head of `buffer`.
 * Returns the parsed messages plus the unconsumed remainder.
 */
export const decodeMessages = (
  buffer: Buffer,
): { messages: JsonRpcMessage[]; rest: Buffer } => {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;

  for (;;) {
    const headerEnd = rest.indexOf(HEADER_SEPARATOR, 0, 'ascii');
    if (headerEnd === -1) break;

    const header = rest.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) throw new Error(`missing Content-Length header: ${JSON.stringify(header)}`);

    const length = Number(match[1]);
    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    if (rest.length < bodyStart + length) break;

    const body = rest.subarray(bodyStart, bodyStart + length).toString('utf8');
    messages.push(JSON.parse(body) as JsonRpcMessage);
    rest = rest.subarray(bodyStart + length);
  }

  return { messages, rest: Buffer.from(rest) };
};

// ---------------------------------------------------------------------------
// nREPL response aggregation
// ---------------------------------------------------------------------------

export interface EvalSummary {
  value?: string;
  out: string;
  err: string;
  statuses: string[];
}

export const summarizeResponses = (responses: readonly NReplResponse[]): EvalSummary => {
  const summary: EvalSummary = { out: '', err: '', statuses: [] };
  responses.forEach((res) => {
    if (res.out !== undefined) summary.out += res.out;
    if (res.err !== undefined) summary.err += res.err;
    if (res.value !== undefined) summary.value = res.value;
    res.status?.forEach((s) => {
      if (!summary.statuses.includes(s)) summary.statuses.push(s);
    });
  });
  if (summary.statuses.includes('unknown-session') && summary.err === '') {
    summary.err = 'unknown session';
  }
  return summary;
};

// ---------------------------------------------------------------------------
// LSP types (minimal subset)
// ---------------------------------------------------------------------------

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface ConnectionOptions {
  host?: string;
  port?: number;
  autoConnect?: boolean;
}

export interface EvalArgs {
  uri: string;
  range: Range;
  code: string;
}

export const COMMAND_CONNECT = 'nrepl/connect';
export const COMMAND_DISCONNECT = 'nrepl/disconnect';
export const COMMAND_EVAL = 'nrepl/eval';
export const CODE_ACTION_TITLE = 'Evaluate form (nREPL)';

const MessageType = { Error: 1, Warning: 2, Info: 3, Log: 4 } as const;
const DiagnosticSeverity = { Error: 1 } as const;
const ErrorCodes = { InvalidParams: -32602, MethodNotFound: -32601, InternalError: -32603 } as const;

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface LspTransport {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface LspServer {
  /** Resolves once the input stream ends or `exit` is received. */
  readonly done: Promise<void>;
  /** Close the nREPL connection (if any) without exiting the process. */
  dispose(): Promise<void>;
}

interface Connection {
  client: NReplClient;
  session: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPosition = (value: unknown): value is Position =>
  isRecord(value) && typeof value.line === 'number' && typeof value.character === 'number';

const isRange = (value: unknown): value is Range =>
  isRecord(value) && isPosition(value.start) && isPosition(value.end);

const isEmptyRange = (range: Range): boolean =>
  range.start.line === range.end.line && range.start.character === range.end.character;

const toConnectionOptions = (value: unknown): ConnectionOptions => {
  if (!isRecord(value)) return {};
  return {
    host: typeof value.host === 'string' ? value.host : undefined,
    port: typeof value.port === 'number' ? value.port : undefined,
    autoConnect: typeof value.autoConnect === 'boolean' ? value.autoConnect : undefined,
  };
};

const toEvalArgs = (value: unknown): EvalArgs | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.uri !== 'string' || typeof value.code !== 'string' || !isRange(value.range)) {
    return undefined;
  }
  return { uri: value.uri, range: value.range, code: value.code };
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const startLspServer = (transport: LspTransport): LspServer => {
  let buffered: Buffer = Buffer.alloc(0);
  let options: ConnectionOptions = {};
  let connection: Connection | undefined;
  const documents = new Map<string, string>();

  const write = (msg: JsonRpcMessage): void => {
    transport.output.write(encodeMessage(msg));
  };

  const notify = (method: string, params: unknown): void => write({ jsonrpc: '2.0', method, params });

  const showMessage = (type: number, message: string): void =>
    notify('window/showMessage', { type, message });

  const publishDiagnostics = (uri: string, range: Range | undefined, message: string | undefined): void =>
    notify('textDocument/publishDiagnostics', {
      uri,
      diagnostics:
        range && message !== undefined
          ? [{ range, severity: DiagnosticSeverity.Error, source: 'nrepl', message }]
          : [],
    });

  const disconnect = async (): Promise<void> => {
    const current = connection;
    connection = undefined;
    if (!current) return;
    await current.client.close(current.session).catch(() => undefined);
    await current.client.disconnect().catch(() => undefined);
  };

  const establish = async (opts: ConnectionOptions): Promise<Connection> => {
    await disconnect();
    const client = await connect(opts.port ?? DEFAULT_PORT, opts.host ?? '127.0.0.1');
    try {
      const session = await client.clone();
      connection = { client, session };
      return connection;
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      throw err;
    }
  };

  const doConnect = async (args: unknown): Promise<unknown> => {
    const overrides = toConnectionOptions(args);
    const opts: ConnectionOptions = {
      host: overrides.host ?? options.host,
      port: overrides.port ?? options.port,
    };
    try {
      const { session } = await establish(opts);
      showMessage(
        MessageType.Info,
        `nREPL: connected to ${opts.host ?? '127.0.0.1'}:${opts.port ?? DEFAULT_PORT} (session ${session})`,
      );
      return { connected: true, session };
    } catch (err) {
      showMessage(MessageType.Error, `nREPL: connection failed: ${errorMessage(err)}`);
      return { connected: false };
    }
  };

  const doEval = async (args: EvalArgs): Promise<unknown> => {
    if (!connection) {
      showMessage(MessageType.Warning, 'nREPL: not connected (run nrepl/connect first)');
      return { ok: false };
    }
    const { client, session } = connection;
    let summary: EvalSummary;
    try {
      summary = summarizeResponses(await client.eval(args.code, session));
    } catch (err) {
      connection = undefined;
      await client.disconnect().catch(() => undefined);
      showMessage(MessageType.Error, `nREPL: evaluation failed: ${errorMessage(err)}`);
      publishDiagnostics(args.uri, args.range, errorMessage(err));
      return { ok: false };
    }

    if (summary.err !== '') {
      publishDiagnostics(args.uri, args.range, summary.err);
      showMessage(MessageType.Error, `nREPL error: ${summary.err}`);
      return { ok: false, err: summary.err };
    }

    publishDiagnostics(args.uri, undefined, undefined);
    const lines: string[] = [];
    if (summary.out !== '') lines.push(summary.out.trimEnd());
    if (summary.value !== undefined) lines.push(`=> ${summary.value}`);
    if (lines.length === 0) lines.push('=> (no value)');
    showMessage(MessageType.Info, lines.join('\n'));
    return { ok: true, value: summary.value, out: summary.out };
  };

  const extractText = (uri: string, range: Range): string | undefined => {
    const text = documents.get(uri);
    if (text === undefined) return undefined;
    const lines = text.split(/\r?\n/);
    const selected = lines.slice(range.start.line, range.end.line + 1);
    if (selected.length === 0) return '';
    if (selected.length === 1) {
      return selected[0].slice(range.start.character, range.end.character);
    }
    selected[0] = selected[0].slice(range.start.character);
    selected[selected.length - 1] = selected[selected.length - 1].slice(0, range.end.character);
    return selected.join('\n');
  };

  const handleCodeAction = (params: unknown): unknown => {
    if (!isRecord(params) || !isRecord(params.textDocument) || !isRange(params.range)) return [];
    const uri = params.textDocument.uri;
    if (typeof uri !== 'string' || isEmptyRange(params.range)) return [];

    if (!connection) {
      return [
        {
          title: 'Connect to nREPL',
          kind: 'source',
          command: { title: 'Connect to nREPL', command: COMMAND_CONNECT, arguments: [] },
        },
      ];
    }

    const code = extractText(uri, params.range) ?? '';
    const args: EvalArgs = { uri, range: params.range, code };
    return [
      {
        title: CODE_ACTION_TITLE,
        kind: 'source',
        command: { title: CODE_ACTION_TITLE, command: COMMAND_EVAL, arguments: [args] },
      },
    ];
  };

  const handleExecuteCommand = async (params: unknown): Promise<unknown> => {
    if (!isRecord(params) || typeof params.command !== 'string') {
      throw new RpcError(ErrorCodes.InvalidParams, 'executeCommand requires a command');
    }
    const args = Array.isArray(params.arguments) ? params.arguments : [];
    switch (params.command) {
      case COMMAND_CONNECT:
        return doConnect(args[0]);
      case COMMAND_DISCONNECT:
        await disconnect();
        showMessage(MessageType.Info, 'nREPL: disconnected');
        return { connected: false };
      case COMMAND_EVAL: {
        const evalArgs = toEvalArgs(args[0]);
        if (!evalArgs) {
          throw new RpcError(ErrorCodes.InvalidParams, 'nrepl/eval requires { uri, range, code }');
        }
        return doEval(evalArgs);
      }
      default:
        throw new RpcError(ErrorCodes.InvalidParams, `unknown command: ${params.command}`);
    }
  };

  const handleInitialize = async (params: unknown): Promise<unknown> => {
    options = toConnectionOptions(isRecord(params) ? params.initializationOptions : undefined);
    if (options.autoConnect && options.host !== undefined && options.port !== undefined) {
      await doConnect(undefined);
    }
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1 },
        codeActionProvider: true,
        executeCommandProvider: {
          commands: [COMMAND_CONNECT, COMMAND_DISCONNECT, COMMAND_EVAL],
        },
      },
      serverInfo: { name: 'ts-nrepl-lsp', version: '0.1.0' },
    };
  };

  const trackDocument = (params: unknown): void => {
    if (!isRecord(params) || !isRecord(params.textDocument)) return;
    const { uri } = params.textDocument;
    if (typeof uri !== 'string') return;
    if (typeof params.textDocument.text === 'string') {
      documents.set(uri, params.textDocument.text);
      return;
    }
    if (Array.isArray(params.contentChanges)) {
      const last = params.contentChanges.at(-1);
      if (isRecord(last) && typeof last.text === 'string') documents.set(uri, last.text);
    }
  };

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'initialize':
        return handleInitialize(params);
      case 'shutdown':
        await disconnect();
        return null;
      case 'textDocument/codeAction':
        return handleCodeAction(params);
      case 'workspace/executeCommand':
        return handleExecuteCommand(params);
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  };

  const handleNotification = async (method: string, params: unknown): Promise<void> => {
    switch (method) {
      case 'initialized':
      case '$/cancelRequest':
      case '$/setTrace':
      case 'textDocument/didSave':
        return;
      case 'textDocument/didOpen':
      case 'textDocument/didChange':
        trackDocument(params);
        return;
      case 'textDocument/didClose':
        if (isRecord(params) && isRecord(params.textDocument) && typeof params.textDocument.uri === 'string') {
          documents.delete(params.textDocument.uri);
        }
        return;
      case 'exit':
        await disconnect();
        resolveDone();
        return;
      default:
        return;
    }
  };

  const dispatch = async (msg: JsonRpcMessage): Promise<void> => {
    if (msg.method === undefined) return; // responses from the client are ignored
    if (msg.id === undefined) {
      await handleNotification(msg.method, msg.params);
      return;
    }
    try {
      const result = await handleRequest(msg.method, msg.params);
      write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ErrorCodes.InternalError;
      write({ jsonrpc: '2.0', id: msg.id, error: { code, message: errorMessage(err) } });
    }
  };

  // Requests are processed sequentially so evaluations keep their order.
  let queue: Promise<void> = Promise.resolve();

  transport.input.on('data', (chunk: Buffer | string) => {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let decoded: ReturnType<typeof decodeMessages>;
    try {
      decoded = decodeMessages(buffered);
    } catch (err) {
      console.error(`lsp: ${errorMessage(err)}`);
      buffered = Buffer.alloc(0);
      return;
    }
    buffered = decoded.rest;
    decoded.messages.forEach((msg) => {
      queue = queue.then(() => dispatch(msg));
    });
  });

  transport.input.on('end', () => {
    queue = queue.then(disconnect).then(resolveDone);
  });

  return { done, dispose: disconnect };
};

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];

if (isMain) {
  // `--stdio` (as passed by editors) is accepted and ignored: stdio is the only transport.
  const server = startLspServer({ input: process.stdin, output: process.stdout });
  await server.done;
  process.exit(0);
}
