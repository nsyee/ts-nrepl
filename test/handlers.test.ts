import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage } from '../src/handlers.ts';
import { createServerContext } from '../src/types.ts';

const cloneSession = (route: ReturnType<typeof routeMessage>): string => {
  const [res] = route({ id: '1', op: 'clone' });
  const session = res?.['new-session'];
  assert.ok(session);
  return session;
};

test('clone creates a session', () => {
  const ctx = createServerContext();
  const route = routeMessage(ctx);
  const session = cloneSession(route);
  assert.equal(ctx.sessions.size, 1);
  assert.ok(ctx.sessions.has(session));
});

test('eval returns the value then done', () => {
  const route = routeMessage(createServerContext());
  const session = cloneSession(route);
  const responses = route({ id: '2', op: 'eval', session, code: '1 + 1' });
  assert.deepEqual(responses, [
    { id: '2', session, value: '2' },
    { id: '2', session, status: ['done'] },
  ]);
});

test('eval strips TypeScript types and keeps session state', () => {
  const route = routeMessage(createServerContext());
  const session = cloneSession(route);
  route({ id: '2', op: 'eval', session, code: 'const x: number = 41;' });
  const [value] = route({ id: '3', op: 'eval', session, code: 'x + 1' });
  assert.equal(value?.value, '42');
});

test('sessions are isolated from each other', () => {
  const route = routeMessage(createServerContext());
  const a = cloneSession(route);
  const b = cloneSession(route);
  route({ id: '2', op: 'eval', session: a, code: 'var shared = 1;' });
  const [err] = route({ id: '3', op: 'eval', session: b, code: 'shared' });
  assert.match(err?.err ?? '', /shared is not defined/);
  assert.deepEqual(err?.status, ['eval-error']);
});

test('eval reports errors with eval-error followed by done', () => {
  const route = routeMessage(createServerContext());
  const session = cloneSession(route);
  const [err, done] = route({ id: '2', op: 'eval', session, code: 'throw new Error("boom")' });
  assert.match(err?.err ?? '', /boom/);
  assert.deepEqual(done?.status, ['done']);
});

test('eval on an unknown session reports unknown-session', () => {
  const route = routeMessage(createServerContext());
  const responses = route({ id: '2', op: 'eval', session: 'nope', code: '1' });
  assert.deepEqual(responses, [
    { id: '2', session: 'nope', status: ['error', 'unknown-session', 'done'] },
  ]);
});

test('close removes the session', () => {
  const ctx = createServerContext();
  const route = routeMessage(ctx);
  const session = cloneSession(route);
  const [res] = route({ id: '2', op: 'close', session });
  assert.equal(ctx.sessions.size, 0);
  assert.deepEqual(res?.status, ['session-closed', 'done']);
});

test('unknown ops are reported but still terminated with done', () => {
  const route = routeMessage(createServerContext());
  const [res] = route({ id: '2', op: 'nope' });
  assert.deepEqual(res?.status, ['error', 'unknown-op', 'done']);
});

test('every op finishes with a done status', () => {
  const route = routeMessage(createServerContext());
  const session = cloneSession(route);
  const ops = [
    { id: '2', op: 'describe' },
    { id: '3', op: 'eval', session, code: '1' },
    { id: '4', op: 'eval', session },
    { id: '5', op: 'close', session },
  ];
  ops.forEach((msg) => {
    const responses = route(msg);
    assert.ok(responses.at(-1)?.status?.includes('done'), `op ${msg.op} must end with done`);
  });
});
