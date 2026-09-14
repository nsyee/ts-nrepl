import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { attachWebSocketServer, type WebSocketConnection } from '../src/websocket.ts';

const openWebSocket = (port: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/nrepl`);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

test('WebSocket server echoes short and extended text frames', async () => {
  const server = http.createServer();
  const connections: WebSocketConnection[] = [];
  attachWebSocketServer(
    server,
    (connection) => {
      connections.push(connection);
      connection.onMessage((text) => connection.send(text));
    },
    '/nrepl',
  );
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const socket = await openWebSocket(address.port);

  const roundtrip = (text: string): Promise<string> =>
    new Promise((resolve, reject) => {
      socket.addEventListener(
        'message',
        (event: MessageEvent) => resolve(String(event.data)),
        { once: true },
      );
      socket.addEventListener('error', reject, { once: true });
      socket.send(text);
    });

  assert.equal(await roundtrip('hello'), 'hello');
  assert.equal((await roundtrip('x'.repeat(200))).length, 200);
  assert.equal((await roundtrip('x'.repeat(70_000))).length, 70_000);

  const closed = new Promise<void>((resolve) => connections[0]?.onClose(resolve));
  socket.close();
  await closed;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
