import net from 'node:net';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { decodeAll, encode, type BencodeValue } from './bencode.ts';
import { DEFAULT_PORT } from './server.ts';
import { toBencodeDict, type NReplMessage, type NReplResponse } from './types.ts';

const asString = (value: BencodeValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const toResponse = (value: BencodeValue): NReplResponse | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const status = Array.isArray(value.status)
    ? value.status.filter((s): s is string => typeof s === 'string')
    : undefined;

  return {
    id: asString(value.id) ?? '',
    session: asString(value.session),
    status,
    value: asString(value.value),
    err: asString(value.err),
    out: asString(value.out),
    'new-session': asString(value['new-session']),
  };
};

const isDone = (res: NReplResponse): boolean => res.status?.includes('done') ?? false;

export interface NReplClient {
  /** Send a message and resolve with every response up to `status: ["done"]`. */
  send(msg: Omit<NReplMessage, 'id'> & { id?: string }): Promise<NReplResponse[]>;
  clone(): Promise<string>;
  eval(code: string, session: string): Promise<NReplResponse[]>;
  close(session: string): Promise<NReplResponse[]>;
  disconnect(): Promise<void>;
}

export const connect = (
  port: number = DEFAULT_PORT,
  host = '127.0.0.1',
): Promise<NReplClient> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    const pending = new Map<
      string,
      {
        responses: NReplResponse[];
        resolve: (r: NReplResponse[]) => void;
        reject: (err: Error) => void;
      }
    >();
    let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let closed = false;

    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const { values, rest } = decodeAll(buffered);
      buffered = rest;

      values.forEach((value) => {
        const res = toResponse(value);
        const entry = res && pending.get(res.id);
        if (!res || !entry) return;

        entry.responses.push(res);
        if (isDone(res)) {
          pending.delete(res.id);
          entry.resolve(entry.responses);
        }
      });
    });

    socket.once('error', reject);

    // Without this a request in flight when the server goes away would hang forever.
    socket.on('close', () => {
      closed = true;
      const inFlight = [...pending.values()];
      pending.clear();
      inFlight.forEach((entry) =>
        entry.reject(new Error('connection closed before the response was complete')),
      );
    });

    socket.once('connect', () => {
      socket.removeListener('error', reject);
      socket.on('error', (err) => console.error('client socket error:', err.message));

      const send: NReplClient['send'] = (msg) => {
        const id = msg.id ?? crypto.randomUUID();
        return new Promise((resolveSend, rejectSend) => {
          if (closed) {
            rejectSend(new Error('client is disconnected'));
            return;
          }
          pending.set(id, { responses: [], resolve: resolveSend, reject: rejectSend });
          socket.write(encode(toBencodeDict({ ...msg, id })));
        });
      };

      resolve({
        send,
        clone: async () => {
          const responses = await send({ op: 'clone' });
          const session = responses.find((r) => r['new-session'])?.['new-session'];
          if (!session) throw new Error('clone did not return a new-session');
          return session;
        },
        eval: (code, session) => send({ op: 'eval', code, session }),
        close: (session) => send({ op: 'close', session }),
        disconnect: () =>
          new Promise((resolveEnd) => {
            if (closed) {
              resolveEnd();
              return;
            }
            socket.once('close', () => resolveEnd());
            socket.end();
          }),
      });
    });
  });

const printResponses = (responses: readonly NReplResponse[]): void => {
  responses.forEach((res) => {
    if (res.out !== undefined) process.stdout.write(res.out);
    if (res.err !== undefined) console.error(res.err);
    if (res.value !== undefined) console.log(`=> ${res.value}`);
  });
};

const repl = async (port: number): Promise<void> => {
  const client = await connect(port);
  const session = await client.clone();
  console.log(`connected to nREPL on port ${port} (session ${session})`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('nrepl> ');

  // With piped stdin the interface closes while an eval is in flight, so the
  // prompt must not be re-issued afterwards.
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  rl.prompt();

  try {
    // Iterating the interface ends the loop on EOF as well as on `:quit`.
    for await (const line of rl) {
      const code = line.trim();
      if (code === ':quit' || code === ':exit') break;
      if (code !== '') {
        try {
          printResponses(await client.eval(code, session));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          break;
        }
      }
      if (!closed) rl.prompt();
    }
  } finally {
    rl.close();
    await client.close(session).catch(() => undefined);
    await client.disconnect();
  }
};

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];

if (isMain) {
  const port = Number(process.argv[2] ?? process.env.NREPL_PORT ?? DEFAULT_PORT);
  await repl(port);
}
