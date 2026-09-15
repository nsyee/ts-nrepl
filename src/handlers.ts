import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { evalInBrowser } from './browser-bridge.ts';
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

const resolveSpecifier = (specifier: string, projectRoot: string): string => {
  if (specifier.startsWith('node:')) return specifier;
  const resolved = createRequire(path.join(projectRoot, 'noop.js')).resolve(specifier);
  return resolved.startsWith('node:') || !path.isAbsolute(resolved)
    ? resolved
    : pathToFileURL(resolved).href;
};

const linkModule =
  (context: vm.Context, projectRoot: string) =>
  async (specifier: string): Promise<vm.Module> => {
    const ns: Record<string, unknown> = await import(resolveSpecifier(specifier, projectRoot));
    const keys = Object.keys(ns);
    return new vm.SyntheticModule(
      keys,
      function () {
        for (const key of keys) this.setExport(key, ns[key]);
      },
      { context },
    );
  };

const dynamicLinkModule =
  (context: vm.Context, projectRoot: string) =>
  async (specifier: string): Promise<vm.Module> => {
    const module = await linkModule(context, projectRoot)(specifier);
    await module.link(() => {
      throw new Error('Synthetic modules cannot import dependencies');
    });
    await module.evaluate();
    return module;
  };

const createModule = async (
  source: string,
  context: vm.Context,
  projectRoot: string,
): Promise<vm.SourceTextModule> => {
  const link = linkModule(context, projectRoot);
  const dynamicLink = dynamicLinkModule(context, projectRoot);
  let module: vm.SourceTextModule;
  try {
    module = new vm.SourceTextModule(source, {
      context,
      identifier: EVAL_FILENAME,
      importModuleDynamically: dynamicLink,
    });
  } catch (err) {
    throw new SyntaxError(String(err).replace(/^SyntaxError:\s*/, ''));
  }
  await module.link(link);
  await module.evaluate();
  return module;
};

const trailingExpression = (
  source: string,
): { prefix: string; expression: string } | undefined => {
  const semicolons: number[] = [];
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === ';' && parentheses === 0 && brackets === 0 && braces === 0) {
      semicolons.push(index);
    }
  }

  for (let index = semicolons.length - 1; index >= 0; index -= 1) {
    const semicolon = semicolons[index];
    const expression = source.slice(semicolon + 1).trim();
    if (expression.length === 0) continue;
    if (
      /^(?:async\s+function|break|class|const|continue|debugger|do|export|for|function|if|import|let|return|switch|throw|try|var|while)\b/.test(
        expression,
      )
    ) {
      return undefined;
    }
    return { prefix: source.slice(0, semicolon + 1), expression };
  }
  return undefined;
};

/**
 * Evaluate as an ES module. First try wrapping as `export default (code)` to capture the
 * value of a single expression; if that is a SyntaxError, evaluate the code as statements
 * and return its default export, if any (same fallback as browser-client.ts `evaluate`).
 */
const evalAsModule = async (
  jsCode: string,
  context: vm.Context,
  projectRoot: string,
): Promise<unknown> => {
  try {
    const module = await createModule(`export default (\n${jsCode}\n);`, context, projectRoot);
    return (module.namespace as { default: unknown }).default;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  const expression = trailingExpression(jsCode);
  if (expression !== undefined) {
    try {
      const module = await createModule(
        `export default (await (async () => {\n${expression.prefix}\nreturn await (${expression.expression});\n})());`,
        context,
        projectRoot,
      );
      return (module.namespace as { default?: unknown }).default;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  const module = await createModule(jsCode, context, projectRoot);
  return (module.namespace as { default?: unknown }).default;
};

/** Report the error plus only the stack frames belonging to evaluated code. */
const formatError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);

  const header = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at ') && line.includes(EVAL_FILENAME));

  return [header, ...frames].join('\n');
};

export const handleEval = async (
  msg: NReplMessage,
  ctx: ServerContext,
): Promise<NReplResponse[]> => {
  const context = msg.session ? ctx.sessions.get(msg.session) : undefined;
  if (!context) {
    return [{ id: msg.id, session: msg.session, status: ['error', 'unknown-session', 'done'] }];
  }
  if (!msg.code) return [done(msg)];

  try {
    const jsCode = stripTypeScriptTypes(msg.code, { mode: 'strip' });
    if (ctx.target === 'browser') {
      const result = await evalInBrowser(ctx.browser, msg.id, jsCode);
      const responses: NReplResponse[] = [];
      if (result.out !== undefined) {
        responses.push({ id: msg.id, session: msg.session, out: result.out });
      }
      if (result.value !== undefined) {
        responses.push({ id: msg.id, session: msg.session, value: result.value });
      } else if (result.err !== undefined) {
        responses.push({
          id: msg.id,
          session: msg.session,
          err: result.err,
          status: ['eval-error'],
        });
      }
      responses.push(done(msg));
      return responses;
    }
    const result = await evalAsModule(jsCode, context, ctx.projectRoot);
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
  (msg: NReplMessage): Promise<NReplResponse[]> => {
    switch (msg.op) {
      case 'clone':
        return Promise.resolve(handleClone(msg, ctx));
      case 'eval':
        return handleEval(msg, ctx);
      case 'close':
        return Promise.resolve(handleClose(msg, ctx));
      case 'describe':
        return Promise.resolve(handleDescribe(msg));
      default:
        return Promise.resolve([done(msg, { status: ['error', 'unknown-op', 'done'] })]);
    }
  };
