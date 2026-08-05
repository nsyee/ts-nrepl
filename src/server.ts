import net from 'node:net';
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
  const respond = pipe(route, write);

  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);

    try {
      const { values, rest } = decodeAll(buffered);
      buffered = rest;
      values.forEach((value) => {
        const msg = toNReplMessage(value);
        if (msg) respond(msg);
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

export const startServer = (port: number = DEFAULT_PORT): Promise<NReplServer> =>
  new Promise((resolve, reject) => {
    const nrepl = createNReplServer();
    nrepl.server.once('error', reject);
    nrepl.server.listen(port, () => resolve(nrepl));
  });

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];

if (isMain) {
  const port = Number(process.env.NREPL_PORT ?? DEFAULT_PORT);
  const { server } = await startServer(port);
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`nREPL TS server listening on port ${boundPort}`);
}
