import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type NReplServer } from '../src/server.ts';
import { connect, type NReplClient } from '../src/client.ts';

const withClient = async (fn: (client: NReplClient) => Promise<void>): Promise<void> => {
  let nrepl: NReplServer | undefined;
  let client: NReplClient | undefined;
  try {
    nrepl = await startServer(0);
    const address = nrepl.server.address();
    assert.ok(address !== null && typeof address === 'object');
    client = await connect(address.port);
    await fn(client);
  } finally {
    await client?.disconnect();
    await new Promise<void>((resolve) => nrepl?.server.close(() => resolve()));
  }
};

test('client clones, evaluates and closes over TCP', async () => {
  await withClient(async (client) => {
    const session = await client.clone();
    assert.match(session, /^[0-9a-f-]{36}$/);

    const responses = await client.eval('const greet = (n: string): string => `hi ${n}`; greet("nrepl")', session);
    assert.equal(responses.find((r) => r.value !== undefined)?.value, '"hi nrepl"');
    assert.ok(responses.at(-1)?.status?.includes('done'));

    const closed = await client.close(session);
    assert.ok(closed.at(-1)?.status?.includes('done'));

    const afterClose = await client.eval('1', session);
    assert.ok(afterClose.at(-1)?.status?.includes('unknown-session'));
  });
});

test('concurrent evals are routed back by message id', async () => {
  await withClient(async (client) => {
    const session = await client.clone();
    const results = await Promise.all([
      client.eval('1 + 1', session),
      client.eval('"a".repeat(3)', session),
      client.eval('throw new Error("boom")', session),
    ]);

    assert.equal(results[0].find((r) => r.value)?.value, '2');
    assert.equal(results[1].find((r) => r.value)?.value, '"aaa"');
    assert.match(results[2].find((r) => r.err)?.err ?? '', /boom/);
    results.forEach((responses) => assert.ok(responses.at(-1)?.status?.includes('done')));
  });
});
