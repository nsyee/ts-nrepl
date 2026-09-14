import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrowserWebSocketServer,
  evalInBrowser,
} from '../src/browser-bridge.ts';
import { routeMessage } from '../src/handlers.ts';
import { createServerContext } from '../src/types.ts';

const connectBrowser = (port: number, onRequest: (request: { id: string; code: string }) => unknown) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/nrepl`);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('WebSocket connection failed'));
    socket.onmessage = (event) => {
      let request: { id: string; code: string };
      try {
        request = JSON.parse(String(event.data)) as { id: string; code: string };
      } catch {
        return;
      }
      const response = onRequest(request);
      if (response !== undefined) socket.send(JSON.stringify(response));
    };
  });

const closeServer = async (
  server: Awaited<ReturnType<typeof createBrowserWebSocketServer>>,
): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

test('browser bridge routes values, errors, timeouts, and disconnects', async () => {
  const ctx = createServerContext('browser');
  const route = routeMessage(ctx);
  const session = (await route({ id: 'clone', op: 'clone' }))[0]?.['new-session'];
  assert.ok(session);

  const unavailable = await route({ id: 'missing', op: 'eval', session, code: '1' });
  assert.match(unavailable[0]?.err ?? '', /No browser connected/);
  assert.deepEqual(unavailable.at(-1)?.status, ['done']);

  const server = await createBrowserWebSocketServer(ctx.browser, 0);
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const browserA = await connectBrowser(address.port, ({ id }) => ({ id, value: '"a"' }));
  const browserAClosed = new Promise<number>((resolve) => {
    browserA.addEventListener(
      'close',
      (event: Event) => resolve((event as CloseEvent).code),
      { once: true },
    );
  });
  const browser = await connectBrowser(address.port, ({ id, code }) =>
    code === 'timeout'
      ? undefined
      : code === 'error'
        ? { id, err: 'ReferenceError: x' }
        : { id, value: '"b"' },
  );
  assert.equal(await browserAClosed, 4000);

  const value = await route({ id: 'value', op: 'eval', session, code: '1 + 1' });
  assert.equal(value.find((response) => response.value)?.value, '"b"');

  const error = await route({ id: 'error', op: 'eval', session, code: 'error' });
  assert.deepEqual(error.find((response) => response.status)?.status, ['eval-error']);

  const timeout = await evalInBrowser(ctx.browser, 'timeout', 'timeout', 10);
  assert.match(timeout.err ?? '', /timed out after 10ms/);

  const disconnected = evalInBrowser(ctx.browser, 'disconnect', '1', 1000);
  browser.close();
  assert.match((await disconnected).err ?? '', /disconnected/i);

  await closeServer(server);
});
