import http from 'node:http';
import type { BrowserBridge, EvalResult } from './types.ts';
import type { WebSocketConnection } from './websocket.ts';
import { attachWebSocketServer } from './websocket.ts';

export const EVAL_TIMEOUT_MS = 30_000;
export const DEFAULT_WS_PORT = 7889;
export const SUPERSEDED_CLOSE_CODE = 4000;

export const evalInBrowser = (
  bridge: BrowserBridge,
  id: string,
  code: string,
  timeoutMs = EVAL_TIMEOUT_MS,
): Promise<EvalResult> => {
  if (bridge.socket === undefined) {
    return Promise.resolve({ err: 'No browser connected: open the Vite dev page first' });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      resolve({ err: `Browser eval timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    bridge.pending.set(id, { resolve, timer });
    bridge.socket?.send(JSON.stringify({ id, code }));
  });
};

export const acceptBrowser = (bridge: BrowserBridge, conn: WebSocketConnection): void => {
  // This PoC supports a single tab; multi-tab routing is a future extension.
  const previous = bridge.socket;
  bridge.socket = conn;
  previous?.close(SUPERSEDED_CLOSE_CODE, 'superseded by a newer tab');
  conn.onMessage((text) => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const response = message as Record<string, unknown>;
    if (typeof response.id !== 'string') return;
    const pending = bridge.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    bridge.pending.delete(response.id);
    const result: EvalResult = {};
    if (typeof response.value === 'string') result.value = response.value;
    if (typeof response.err === 'string') result.err = response.err;
    if (typeof response.out === 'string') result.out = response.out;
    pending.resolve(result);
  });
  conn.onClose(() => {
    if (bridge.socket !== conn) return;
    bridge.socket = undefined;
    const pending = [...bridge.pending.values()];
    bridge.pending.clear();
    pending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ err: 'Browser disconnected' });
    });
  });
};

export const createBrowserWebSocketServer = (
  bridge: BrowserBridge,
  port: number,
  path = '/nrepl',
): Promise<http.Server> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    attachWebSocketServer(server, (conn) => acceptBrowser(bridge, conn), path);
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
