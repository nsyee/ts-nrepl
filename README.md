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
npm start                 # VM server on port 7888 (override with NREPL_PORT)
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

The VM target evaluates each request as an independent ES module. It supports
`import` statements for `node:` builtins and npm bare specifiers, and supports
top-level await and dynamic imports. VM evaluation requires Node's
`--experimental-vm-modules` flag; `npm start` includes it. Set
`NREPL_PROJECT_ROOT` to choose the project root used to resolve imports (the
default is the current working directory). Bare specifiers use require-style
conditions through `createRequire`, so ESM-only packages that export only
`import` conditions may not resolve. This PoC does not persist session state:
each eval has an independent module scope.

Programmatic client:

```ts
import { connect } from './src/client.ts';

const client = await connect(7888);
const session = await client.clone();
const responses = await client.eval('const x: number = 41; x + 1', session);
await client.close(session);
await client.disconnect();
```

## Browser REPL (PoC)

The browser target sends evaluations from the editor to a browser tab:

`editor → TCP 7888 → ts-nrepl server → WebSocket 7889 → browser → WebSocket → server → editor`

Use the Vite plugin in a Vite project:

```ts
import { defineConfig } from 'vite';
import { tsNrepl } from '../src/vite-plugin.ts';

export default defineConfig({
  plugins: [tsNrepl()],
});
```

The plugin injects a browser client into the dev page and starts an nREPL server
on port 7888 plus a WebSocket server on port 7889. Connect the editor to TCP
port 7888 as usual. The included example can be started with:

```bash
cd example
npm install
npm run dev
```

Standalone mode starts both transports without Vite:

```bash
NREPL_TARGET=browser npm start
```

The browser PoC supports import-free single expressions and statement snippets,
but not import statements. It supports one browser tab at a time: the newest tab wins,
older tabs are detached, and reloading an older tab can reclaim the bridge.
Console output is forwarded only from the current evaluation, and module state
does not persist between evaluations. The WebSocket server is implemented
in-house to keep the runtime dependency count at zero.

## LSP server

`src/lsp-server.ts` is a minimal Language Server (JSON-RPC over stdio, no runtime
dependencies) that forwards selected TypeScript/JavaScript to a running nREPL server and
reports the result back to the editor using standard LSP features only. Type stripping
happens on the nREPL side, so the selection is sent verbatim.

```sh
npm run lsp                        # or
node src/lsp-server.ts --stdio     # `--stdio` is accepted and ignored
```

`initializationOptions`:

```jsonc
{
  "host": "127.0.0.1",   // optional, default 127.0.0.1
  "port": 7888,          // optional, default 7888
  "autoConnect": true    // optional; connect during `initialize` when host and port are set
}
```

Capabilities and behaviour:

| Feature | Details |
| --- | --- |
| `workspace/executeCommand` | `nrepl/connect` (`[{host?, port?}]`), `nrepl/disconnect`, `nrepl/eval` (`[{uri, range, code}]`) |
| `textDocument/codeAction` | For a non-empty selection: **Evaluate form (nREPL)** bound to `nrepl/eval`; when disconnected: **Connect to nREPL** bound to `nrepl/connect` |
| Results | `value` and `out` are shown via `window/showMessage` (Info); `err` (or a dropped connection) is published as an Error diagnostic on the evaluated range via `textDocument/publishDiagnostics`, and cleared on the next successful evaluation |
| `shutdown` / `exit` | Closes the nREPL session and disconnects |

The server keeps a single nREPL connection and session. The document text is tracked via
`textDocument/didOpen` / `didChange` so the code action can fill in the selected code.

To use it from Zed a separate extension is required (`nsyee/zed-nrepl`, Rust compiled to
WASM, launching this server through `language_server_command`). Because LSP has no
Webview-like panel, a Calva-style output view or interactive prompt is not possible; the
experience is limited to messages and diagnostics.

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
   a `Promise<NReplResponse[]>`. VM evaluations are local; browser evaluations
   await a WebSocket response. Only session bookkeeping and browser bridge state
   mutate; no TCP socket access happens here.
3. **Effect** — `src/server.ts` encodes the responses and writes them to the socket.

Because a bencoded message can be split across TCP packets, the server and client buffer
incoming bytes and use `decodeAll`, which returns complete values plus the remainder.

Each session is a separate `vm` context, so evaluations are isolated between sessions.

## Layout

```
src/bencode.ts    Bencode encoder/decoder (incremental)
src/types.ts      Shared types and conversions
src/handlers.ts   clone / eval / close / describe + routing
src/server.ts     TCP server, framing, socket writes
src/client.ts     Promise-based client + interactive REPL
src/lsp-server.ts Language Server (JSON-RPC over stdio) bridging editors to nREPL
src/websocket.ts  Dependency-free RFC 6455 server-side WebSocket framing
src/browser-bridge.ts  Browser evaluation bridge and WebSocket server
src/browser-client.ts   Browser-side evaluator injected by the Vite plugin
src/vite-plugin.ts  Vite integration without importing Vite
example/          Minimal Vite browser REPL project
test/             node:test suites (bencode, handlers, transports, end-to-end)
```

## License

[MIT](LICENSE)
