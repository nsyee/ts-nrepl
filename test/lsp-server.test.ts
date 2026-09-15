import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startServer, type NReplServer } from '../src/server.ts';
import {
  CODE_ACTION_TITLE,
  COMMAND_CONNECT,
  COMMAND_EVAL,
  decodeMessages,
  encodeMessage,
  startLspServer,
  summarizeResponses,
  type JsonRpcMessage,
  type LspServer,
} from '../src/lsp-server.ts';

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

test('encodeMessage writes a Content-Length header and UTF-8 body', () => {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'x', params: { s: 'こんにちは' } };
  const encoded = encodeMessage(msg);
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  assert.equal(
    encoded.toString('utf8'),
    `Content-Length: ${body.length}\r\n\r\n${body.toString('utf8')}`,
  );
  assert.notEqual(body.length, JSON.stringify(msg).length);
});

test('decodeMessages splits several messages and returns the remainder', () => {
  const a: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'a' };
  const b: JsonRpcMessage = { jsonrpc: '2.0', method: 'b', params: [1, 2] };
  const partial = encodeMessage({ jsonrpc: '2.0', id: 3, method: 'c' });
  const buffer = Buffer.concat([encodeMessage(a), encodeMessage(b), partial.subarray(0, 20)]);

  const { messages, rest } = decodeMessages(buffer);
  assert.deepEqual(messages, [a, b]);
  assert.deepEqual(rest, partial.subarray(0, 20));
});

test('decodeMessages handles headers and bodies split across chunks', () => {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 7, method: 'initialize', params: { x: 1 } };
  const encoded = encodeMessage(msg);
  let buffered: Buffer = Buffer.alloc(0);
  const received: JsonRpcMessage[] = [];

  for (let i = 0; i < encoded.length; i += 5) {
    buffered = Buffer.concat([buffered, encoded.subarray(i, i + 5)]);
    const decoded = decodeMessages(buffered);
    buffered = decoded.rest;
    received.push(...decoded.messages);
  }

  assert.deepEqual(received, [msg]);
  assert.equal(buffered.length, 0);
});

test('decodeMessages rejects a header without Content-Length', () => {
  assert.throws(() => decodeMessages(Buffer.from('Foo: bar\r\n\r\n{}')), /Content-Length/);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('summarizeResponses collects value, out and err', () => {
  const summary = summarizeResponses([
    { id: '1', out: 'a' },
    { id: '1', out: 'b\n' },
    { id: '1', value: '3' },
    { id: '1', status: ['done'] },
  ]);
  assert.deepEqual(summary, { value: '3', out: 'ab\n', err: '', statuses: ['done'] });

  const failed = summarizeResponses([
    { id: '2', err: 'Error: boom' },
    { id: '2', status: ['eval-error', 'done'] },
  ]);
  assert.equal(failed.value, undefined);
  assert.equal(failed.err, 'Error: boom');
  assert.deepEqual(failed.statuses, ['eval-error', 'done']);

  const unknown = summarizeResponses([{ id: '3', status: ['error', 'unknown-session', 'done'] }]);
  assert.equal(unknown.err, 'unknown session');
});

// ---------------------------------------------------------------------------
// Integration against an in-process nREPL server
// ---------------------------------------------------------------------------

interface Harness {
  request(method: string, params: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params: unknown): void;
  waitFor(method: string): Promise<JsonRpcMessage>;
  notifications: JsonRpcMessage[];
}

const withLsp = async (fn: (h: Harness, port: number) => Promise<void>): Promise<void> => {
  let nrepl: NReplServer | undefined;
  let lsp: LspServer | undefined;
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    nrepl = await startServer(0);
    const address = nrepl.server.address();
    assert.ok(address !== null && typeof address === 'object');

    lsp = startLspServer({ input, output });

    const notifications: JsonRpcMessage[] = [];
    const pending = new Map<number, (m: JsonRpcMessage) => void>();
    const waiters: { method: string; resolve: (m: JsonRpcMessage) => void }[] = [];
    let buffered: Buffer = Buffer.alloc(0);
    output.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeMessages(buffered);
      buffered = decoded.rest;
      decoded.messages.forEach((msg) => {
        if (msg.method !== undefined) {
          notifications.push(msg);
          const index = waiters.findIndex((w) => w.method === msg.method);
          if (index !== -1) waiters.splice(index, 1)[0].resolve(msg);
          return;
        }
        if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
      });
    });

    let nextId = 0;
    const harness: Harness = {
      notifications,
      request: (method, params) =>
        new Promise((resolve) => {
          const id = ++nextId;
          pending.set(id, resolve);
          input.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
        }),
      notify: (method, params) => {
        input.write(encodeMessage({ jsonrpc: '2.0', method, params }));
      },
      waitFor: (method) => {
        const existing = notifications.find((m) => m.method === method);
        if (existing) {
          notifications.splice(notifications.indexOf(existing), 1);
          return Promise.resolve(existing);
        }
        return new Promise((resolve) => waiters.push({ method, resolve }));
      },
    };

    await fn(harness, address.port);
  } finally {
    await lsp?.dispose();
    input.end();
    await new Promise<void>((resolve) => nrepl?.server.close(() => resolve()));
  }
};

const messageOf = (msg: JsonRpcMessage): string => {
  const params = msg.params as { message: string };
  return params.message;
};

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

test('initialize, connect, eval and diagnostics over JSON-RPC', async () => {
  await withLsp(async (h, port) => {
    const init = await h.request('initialize', { processId: null, capabilities: {} });
    const result = init.result as {
      capabilities: { executeCommandProvider: { commands: string[] }; codeActionProvider: boolean };
    };
    assert.deepEqual(result.capabilities.executeCommandProvider.commands, [
      'nrepl/connect',
      'nrepl/disconnect',
      'nrepl/eval',
    ]);
    assert.equal(result.capabilities.codeActionProvider, true);
    h.notify('initialized', {});

    const uri = 'file:///tmp/example.ts';
    h.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text: '1 + 2\nrest' },
    });

    // Not connected yet: the code action offers to connect instead of evaluating.
    const before = await h.request('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context: { diagnostics: [] },
    });
    const beforeActions = before.result as { command: { command: string } }[];
    assert.equal(beforeActions.length, 1);
    assert.equal(beforeActions[0].command.command, COMMAND_CONNECT);

    const connected = await h.request('workspace/executeCommand', {
      command: COMMAND_CONNECT,
      arguments: [{ host: '127.0.0.1', port }],
    });
    assert.deepEqual((connected.result as { connected: boolean }).connected, true);
    assert.match(messageOf(await h.waitFor('window/showMessage')), /connected to 127\.0\.0\.1/);

    const actions = await h.request('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context: { diagnostics: [] },
    });
    const list = actions.result as { title: string; command: { command: string; arguments: unknown[] } }[];
    assert.equal(list.length, 1);
    assert.equal(list[0].title, CODE_ACTION_TITLE);
    assert.equal(list[0].command.command, COMMAND_EVAL);
    assert.deepEqual(list[0].command.arguments[0], { uri, range, code: '1 + 2' });

    const empty = await h.request('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: range.start, end: range.start },
      context: { diagnostics: [] },
    });
    assert.deepEqual(empty.result, []);

    const evaluated = await h.request('workspace/executeCommand', {
      command: COMMAND_EVAL,
      arguments: [list[0].command.arguments[0]],
    });
    assert.equal((evaluated.result as { value: string }).value, '3');
    assert.match(messageOf(await h.waitFor('window/showMessage')), /=> 3/);
    const cleared = await h.waitFor('textDocument/publishDiagnostics');
    assert.deepEqual(cleared.params, { uri, diagnostics: [] });

    const typed = await h.request('workspace/executeCommand', {
      command: COMMAND_EVAL,
      arguments: [{ uri, range, code: 'const n: number = 40; export default n + 2' }],
    });
    assert.equal((typed.result as { value: string }).value, '42');
    assert.match(messageOf(await h.waitFor('window/showMessage')), /=> 42/);
    await h.waitFor('textDocument/publishDiagnostics');

    const failed = await h.request('workspace/executeCommand', {
      command: COMMAND_EVAL,
      arguments: [{ uri, range, code: 'throw new Error("boom")' }],
    });
    assert.equal((failed.result as { ok: boolean }).ok, false);
    const diagnostics = await h.waitFor('textDocument/publishDiagnostics');
    const published = diagnostics.params as {
      uri: string;
      diagnostics: { range: typeof range; severity: number; message: string }[];
    };
    assert.equal(published.uri, uri);
    assert.equal(published.diagnostics.length, 1);
    assert.equal(published.diagnostics[0].severity, 1);
    assert.deepEqual(published.diagnostics[0].range, range);
    assert.match(published.diagnostics[0].message, /boom/);
    assert.match(messageOf(await h.waitFor('window/showMessage')), /boom/);

    const shutdown = await h.request('shutdown', null);
    assert.equal(shutdown.result, null);
  });
});

test('autoConnect on initialize and unknown methods answer with an error', async () => {
  await withLsp(async (h, port) => {
    await h.request('initialize', {
      processId: null,
      capabilities: {},
      initializationOptions: { host: '127.0.0.1', port, autoConnect: true },
    });
    assert.match(messageOf(await h.waitFor('window/showMessage')), /connected/);

    const evaluated = await h.request('workspace/executeCommand', {
      command: COMMAND_EVAL,
      arguments: [{ uri: 'file:///x.ts', range, code: '"a".repeat(2)' }],
    });
    assert.equal((evaluated.result as { value: string }).value, '"aa"');

    const unknown = await h.request('foo/bar', {});
    assert.equal(unknown.error?.code, -32601);
  });
});

test('connection failure is reported via window/showMessage', async () => {
  await withLsp(async (h) => {
    await h.request('initialize', { processId: null, capabilities: {} });
    const result = await h.request('workspace/executeCommand', {
      command: COMMAND_CONNECT,
      arguments: [{ host: '127.0.0.1', port: 1 }],
    });
    assert.deepEqual(result.result, { connected: false });
    assert.match(messageOf(await h.waitFor('window/showMessage')), /connection failed/);
  });
});
