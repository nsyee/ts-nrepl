---
name: testing-ts-nrepl
description: Run real Chrome and TCP client end-to-end checks for ts-nrepl browser and VM modes.
---

# Local runtime testing

## Devin Secrets Needed
None for the localhost Vite example and TCP client.

## Setup
- Use the repository's Node version (currently Node 26 via mise).
- Install root dependencies with `npm install`, and separately install the Vite example's dependencies with `npm install` in `example/`.
- Start `npm run dev` in `example/`: HTTP 5173, nREPL TCP 7888, browser WebSocket 7889 `/nrepl`. Check startup logs for collisions.
- Open `http://localhost:5173` in real Chrome. DevTools Network should show `/@ts-nrepl/browser-client.js` 200 and `/nrepl` WebSocket 101.
- Start root `npm run client` in a GUI terminal for interpretable recordings. On KDE, `konsole --workdir <repo-absolute-path> -e npm run client` works. Keep the browser maximized and page heading visible above the terminal.
- For isolated VM regression, start root `NREPL_PORT=7900 npm start` with NREPL_TARGET unset, then `npm run client -- 7900`.
- Restart Vite after plugin/server changes and hard-reload old pages after browser-client changes.

## Assertions
- Use CLI expressions to verify browser state and visibly mutate `#app`; do not substitute DevTools evaluation for the TCP path.
- Module statement snippets without default export return `undefined`, not the final expression. To prove typed computation, compare `const f = (n: number): number => n * 2; f(21)` with `const f = (n: number): number => n * 2; export default f(21)`.
- CLI output hides status fields. Supplement error/output checks using exported `connect`, `clone`, and `eval` APIs over real TCP; print the full response arrays.
- Distinguish tabs with URL query strings such as `?tab=first` and `?tab=second`, then evaluate `location.search` repeatedly across more than five seconds. An immediate newest-tab result alone cannot detect reconnect ownership churn.
- Superseded tabs may intentionally stop reconnecting; test explicit reload takeover and confirm the documented behavior after the active tab closes.
- Keep at least one New Tab open when closing the final app tab so the recording can show the no-browser condition without closing Chrome.
- Initial favicon 404s should be reported separately from browser-client execution errors.
