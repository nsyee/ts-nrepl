# ts-nrepl

Node.js + TypeScript implementation of an [nREPL](https://nrepl.org/) server and client.

No runtime dependencies: Bencode is implemented from scratch, sandboxing uses `node:vm`,
and TypeScript input is erased with `node:module`'s `stripTypeScriptTypes`.

## Requirements

Node.js >= 22.18 (native TypeScript execution + `stripTypeScriptTypes`).
The pinned version lives in `mise.toml` (Node.js 26).

```bash
mise install      # installs the pinned Node.js toolchain
npm install       # dev-only: typescript + @types/node
```

## Usage

```bash
npm start                 # server on port 7888 (override with NREPL_PORT)
npm run client            # interactive REPL client, `:quit` to exit
npm test                  # node:test suite
npm run typecheck         # tsc --noEmit
```

```
nrepl> const add = (a: number, b: number): number => a + b
=> undefined
nrepl> add(1, 2)
=> 3
```

Programmatic client:

```ts
import { connect } from './src/client.ts';

const client = await connect(7888);
const session = await client.clone();
const responses = await client.eval('const x: number = 41; x + 1', session);
await client.close(session);
await client.disconnect();
```

## Protocol

TCP transport, Bencode encoding, every message is a dictionary.

| op | request | response |
| --- | --- | --- |
| `clone` | `{id, op}` | `{id, new-session, status: ["done"]}` |
| `eval` | `{id, op, session, code}` | `{id, session, value \| err}` then `{id, session, status: ["done"]}` |
| `close` | `{id, op, session}` | `{id, session, status: ["session-closed", "done"]}` |
| `describe` | `{id, op}` | `{id, ops, status: ["done"]}` |

Unknown ops answer `status: ["error", "unknown-op", "done"]`; evaluating in a missing
session answers `status: ["error", "unknown-session", "done"]`. Every op terminates with
a `done` status.

## Architecture

Effects are pushed to the edges:

1. **Parse (pure)** — `src/bencode.ts` decodes stream chunks; `toNReplMessage` narrows
   decoded dictionaries into `NReplMessage`.
2. **Route (pure-ish)** — `src/handlers.ts` maps a message plus `ServerContext` to
   `NReplResponse[]`. Only session bookkeeping mutates state; no socket access.
3. **Effect** — `src/server.ts` encodes the responses and writes them to the socket.

Because a bencoded message can be split across TCP packets, the server and client buffer
incoming bytes and use `decodeAll`, which returns complete values plus the remainder.

Each session is a separate `vm` context, so bindings persist per session and are isolated
between sessions.

## Layout

```
src/bencode.ts    Bencode encoder/decoder (incremental)
src/types.ts      Shared types and conversions
src/handlers.ts   clone / eval / close / describe + routing
src/server.ts     TCP server, framing, socket writes
src/client.ts     Promise-based client + interactive REPL
test/             node:test suites (bencode, handlers, end-to-end)
```
