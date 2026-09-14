/// <reference lib="dom" />

declare global {
  interface Window {
    __TS_NREPL__?: { wsUrl: string };
  }
}

interface BrowserEvalRequest {
  id: string;
  code: string;
}

const stringify = (result: unknown): string => {
  if (typeof result === 'string') return JSON.stringify(result);
  if (typeof result === 'bigint') return `${result}n`;
  if (result === null || result === undefined) return String(result);
  if (typeof result === 'object' || Array.isArray(result)) {
    try {
      return JSON.stringify(result) ?? String(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
};

const evaluate = async (code: string): Promise<string> => {
  let objectUrl: string | undefined;
  try {
    const source = `export default (\n${code}\n);`;
    objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    let module: { default?: unknown };
    try {
      module = (await import(objectUrl)) as { default?: unknown };
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      URL.revokeObjectURL(objectUrl);
      const statementSource = code;
      objectUrl = URL.createObjectURL(
        new Blob([statementSource], { type: 'text/javascript' }),
      );
      module = (await import(objectUrl)) as { default?: unknown };
    }
    return stringify(await module.default);
  } finally {
    if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
  }
};

const run = async (request: BrowserEvalRequest, socket: WebSocket): Promise<void> => {
  const output: string[] = [];
  const methods = ['log', 'warn', 'error'] as const;
  const consoleObject = console as Console & Record<string, (...args: unknown[]) => void>;
  const originals = methods.map((method) => ({ method, fn: consoleObject[method] }));
  methods.forEach((method) => {
    consoleObject[method] = (...args: unknown[]) => {
      output.push(args.map(stringify).join(' '));
      originals.find((original) => original.method === method)?.fn(...args);
    };
  });

  try {
    // This PoC supports import-free single expressions and statement snippets only.
    const value = await evaluate(request.code);
    const response: { id: string; value: string; out?: string } = {
      id: request.id,
      value,
    };
    if (output.length > 0) response.out = output.join('\n');
    socket.send(JSON.stringify(response));
  } catch (error: unknown) {
    const err =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const response: { id: string; err: string; out?: string } = {
      id: request.id,
      err,
    };
    if (output.length > 0) response.out = output.join('\n');
    socket.send(JSON.stringify(response));
  } finally {
    originals.forEach(({ method, fn }) => {
      consoleObject[method] = fn;
    });
  }
};

const connect = (): void => {
  const url = window.__TS_NREPL__?.wsUrl ?? 'ws://localhost:7889/nrepl';
  const socket = new WebSocket(url);
  socket.onmessage = (event: MessageEvent<string>) => {
    let request: unknown;
    try {
      request = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return;
    const value = request as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.code !== 'string') return;
    void run({ id: value.id, code: value.code }, socket);
  };
  socket.onclose = () => {
    window.setTimeout(connect, 1000);
  };
};

connect();

export {};
