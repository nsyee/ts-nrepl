import net from 'node:net';
import { createBrowserWebSocketServer, DEFAULT_WS_PORT } from './browser-bridge.ts';
import { decodeAll, encode } from './bencode.ts';
import { routeMessage } from './handlers.ts';
import {
  createServerContext,
  toBencodeDict,
  toNReplMessage,
  type NReplResponse,
  type ServerContext,
} from './types.ts';

export const DEFAULT_PORT = 7888;

/** Left-to-right function composition. */
export const pipe =
  <A, B, C>(f1: (x: A) => B, f2: (x: B) => C) =>
  (x: A): C =>
    f2(f1(x));

const writeToSocket =
  (socket: net.Socket) =>
  (responses: readonly NReplResponse[]): void => {
    responses.forEach((res) => socket.write(encode(toBencodeDict(res))));
  };

/**
 * Per-connection handler.
 *
 * Chunks are accumulated because a bencoded message may be split across TCP
 * packets; `decodeAll` returns the complete messages plus the leftover bytes.
 */
const handleConnection = (ctx: ServerContext) => (socket: net.Socket): void => {
  const route = routeMessage(ctx);
  const write = writeToSocket(socket);

  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);

    try {
      const { values, rest } = decodeAll(buffered);
      buffered = rest;
      values.forEach((value) => {
        const msg = toNReplMessage(value);
        if (msg) {
          route(msg)
            .then(write)
            .catch((err: unknown) => console.error('handler error:', err));
        }
      });
    } catch (err) {
      console.error('decode error:', err);
      buffered = Buffer.alloc(0);
      socket.destroy();
    }
  });

  socket.on('error', (err) => console.error('socket error:', err.message));
};

export interface NReplServer {
  readonly server: net.Server;
  readonly context: ServerContext;
}

export const createNReplServer = (context: ServerContext = createServerContext()): NReplServer => ({
  server: net.createServer(handleConnection(context)),
  context,
});

export const startServer = (
  port: number = DEFAULT_PORT,
  context = createServerContext(),
): Promise<NReplServer> =>
  new Promise((resolve, reject) => {
    const nrepl = createNReplServer(context);
    nrepl.server.once('error', reject);
    nrepl.server.listen(port, () => resolve(nrepl));
  });

/**
 * Evaluated code runs asynchronously outside of `handleEval`'s try/catch, so a
 * rejected promise or a throw from a timer would otherwise terminate the whole
 * server and every other session with it.
 */
export const guardAgainstEvalCrashes = (): void => {
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason));
  process.on('uncaughtException', (err) => console.error('uncaught exception:', err));
};

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];

if (isMain) {
  guardAgainstEvalCrashes();
  const port = Number(process.env.NREPL_PORT ?? DEFAULT_PORT);
  const target = process.env.NREPL_TARGET === 'browser' ? 'browser' : 'vm';
  const projectRoot = process.env.NREPL_PROJECT_ROOT ?? process.cwd();
  const context = createServerContext(target, projectRoot);
  const { server } = await startServer(port, context);
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`nREPL TS server listening on port ${boundPort}`);
  if (target === 'browser') {
    const wsPort = Number(process.env.NREPL_WS_PORT ?? DEFAULT_WS_PORT);
    const wsServer = await createBrowserWebSocketServer(context.browser, wsPort);
    const wsAddress = wsServer.address();
    const boundWsPort = typeof wsAddress === 'object' && wsAddress !== null ? wsAddress.port : wsPort;
    console.log(`browser WebSocket listening on port ${boundWsPort}`);
  }
}
