import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { routeMessage } from '../src/handlers.ts';
import { createServerContext } from '../src/types.ts';
import { connect } from '../src/client.ts';

test('the sandbox does not expose the host process object', async () => {
  const route = routeMessage(createServerContext());
  const session = (await route({ id: '1', op: 'clone' }))[0]?.['new-session'];
  assert.ok(session);

  const [res] = await route({ id: '2', op: 'eval', session, code: 'typeof process' });
  assert.equal(res?.value, '"undefined"');
});

test('pending requests reject when the connection drops', async () => {
  const accepted: net.Socket[] = [];
  // A server that accepts connections but never answers.
  const silent = net.createServer((socket) => accepted.push(socket));
  silent.listen(0);
  await once(silent, 'listening');

  const address = silent.address();
  assert.ok(address !== null && typeof address === 'object');
  const client = await connect(address.port);

  const inFlight = client.send({ op: 'clone' });
  while (accepted.length === 0) await delay(5);
  accepted[0]?.destroy();

  await assert.rejects(inFlight, /connection closed/);
  await assert.rejects(client.eval('1', 'nope'), /disconnected/);

  await client.disconnect();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

test('async errors in evaluated code do not kill the server process', async () => {
  const child = spawn(process.execPath, ['src/server.ts'], {
    env: { ...process.env, NREPL_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const [banner] = (await once(child.stdout, 'data')) as [Buffer];
    const port = Number(/port (\d+)/.exec(banner.toString())?.[1]);
    assert.ok(Number.isInteger(port) && port > 0, `unexpected banner: ${banner}`);

    const client = await connect(port);
    const session = await client.clone();

    const hazards = [
      'Promise.reject(new Error("nope")); 1',
      '(async () => { throw new Error("x") })(); 1',
      'setTimeout(() => { throw new Error("x") }, 10); 1',
      'typeof process === "undefined" ? 1 : process.exit(0)',
    ];

    for (const code of hazards) {
      await client.eval(code, session);
      await delay(60);
      assert.equal(child.exitCode, null, `server died after evaluating: ${code}`);
      const [alive] = await client.eval('1 + 1', session);
      assert.equal(alive?.value, '2', `server unusable after evaluating: ${code}`);
    }

    await client.disconnect();
  } finally {
    child.kill();
  }
});
