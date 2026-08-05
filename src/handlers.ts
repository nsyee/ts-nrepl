import crypto from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import type { NReplMessage, NReplResponse, ServerContext } from './types.ts';

/**
 * Pure-ish operation handlers: each takes a message plus the server context and
 * returns the responses to send back. Only session bookkeeping mutates state;
 * no socket I/O happens here.
 */

const done = (msg: NReplMessage, extra: Partial<NReplResponse> = {}): NReplResponse => ({
  id: msg.id,
  session: msg.session,
  status: ['done'],
  ...extra,
});

/**
 * Globals exposed to evaluated code. The host `process` is deliberately absent:
 * `process.exit()` from a session would take the whole server down.
 */
const createSessionContext = (): vm.Context =>
  vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    URL,
    TextEncoder,
    TextDecoder,
    Buffer,
  });

export const handleClone = (msg: NReplMessage, ctx: ServerContext): NReplResponse[] => {
  const newSessionId = crypto.randomUUID();
  ctx.sessions.set(newSessionId, createSessionContext());
  return [{ id: msg.id, 'new-session': newSessionId, status: ['done'] }];
};

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

const EVAL_FILENAME = 'nrepl-eval.ts';

/** Report the error plus only the stack frames belonging to evaluated code. */
const formatError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);

  const header = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at ') && line.includes(EVAL_FILENAME));

  return [header, ...frames].join('\n');
};

export const handleEval = (msg: NReplMessage, ctx: ServerContext): NReplResponse[] => {
  const context = msg.session ? ctx.sessions.get(msg.session) : undefined;
  if (!context) {
    return [{ id: msg.id, session: msg.session, status: ['error', 'unknown-session', 'done'] }];
  }
  if (!msg.code) return [done(msg)];

  try {
    const jsCode = stripTypeScriptTypes(msg.code, { mode: 'strip' });
    const result = vm.runInContext(jsCode, context, { filename: EVAL_FILENAME });
    return [
      { id: msg.id, session: msg.session, value: stringify(result) },
      done(msg),
    ];
  } catch (err: unknown) {
    const errorMessage = formatError(err);
    return [
      { id: msg.id, session: msg.session, err: errorMessage, status: ['eval-error'] },
      done(msg),
    ];
  }
};

export const handleClose = (msg: NReplMessage, ctx: ServerContext): NReplResponse[] => {
  if (msg.session) ctx.sessions.delete(msg.session);
  return [done(msg, { status: ['session-closed', 'done'] })];
};

export const handleDescribe = (msg: NReplMessage): NReplResponse[] => [
  done(msg, { ops: { clone: {}, eval: {}, close: {}, describe: {} } }),
];

export const routeMessage =
  (ctx: ServerContext) =>
  (msg: NReplMessage): NReplResponse[] => {
    switch (msg.op) {
      case 'clone':
        return handleClone(msg, ctx);
      case 'eval':
        return handleEval(msg, ctx);
      case 'close':
        return handleClose(msg, ctx);
      case 'describe':
        return handleDescribe(msg);
      default:
        return [done(msg, { status: ['error', 'unknown-op', 'done'] })];
    }
  };
