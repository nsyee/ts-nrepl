import test from 'node:test';
import assert from 'node:assert/strict';
import { BencodeError, decode, decodeAll, encode } from '../src/bencode.ts';

test('encodes primitives', () => {
  assert.equal(encode('spam').toString(), '4:spam');
  assert.equal(encode('').toString(), '0:');
  assert.equal(encode(42).toString(), 'i42e');
  assert.equal(encode(-3).toString(), 'i-3e');
  assert.equal(encode([]).toString(), 'le');
  assert.equal(encode(['done']).toString(), 'l4:donee');
});

test('encodes dictionaries with sorted keys and skips undefined values', () => {
  assert.equal(encode({ op: 'eval', id: '1' }).toString(), 'd2:id1:12:op4:evale');
  assert.equal(
    encode({ id: '1', session: undefined as unknown as string }).toString(),
    'd2:id1:1e',
  );
});

test('encodes utf-8 strings by byte length', () => {
  assert.equal(encode('あ').toString(), '3:あ');
  assert.equal(decode(encode('日本語')), '日本語');
});

test('round-trips nested structures', () => {
  const value = { id: '1', status: ['done'], nested: { n: 7, list: ['a', 1] } };
  assert.deepEqual(decode(encode(value)), value);
});

test('rejects malformed input', () => {
  assert.throws(() => decode(Buffer.from('i1x2e')), BencodeError);
  assert.throws(() => decode(Buffer.from('x')), BencodeError);
  assert.throws(() => decode(Buffer.from('4:spam4:eggs')), BencodeError);
  assert.throws(() => encode(1.5), BencodeError);
});

test('decodeAll returns complete values and keeps the remainder', () => {
  const buf = Buffer.concat([encode({ id: '1' }), Buffer.from('d2:id1:2')]);
  const { values, rest } = decodeAll(buf);
  assert.deepEqual(values, [{ id: '1' }]);
  assert.equal(rest.toString(), 'd2:id1:2');
});

test('decodeAll handles a stream split at arbitrary byte boundaries', () => {
  const full = Buffer.concat([encode({ id: '1', op: 'clone' }), encode({ id: '2', op: 'close' })]);

  for (let split = 1; split < full.length; split += 1) {
    const first = decodeAll(full.subarray(0, split));
    const second = decodeAll(Buffer.concat([first.rest, full.subarray(split)]));
    assert.deepEqual([...first.values, ...second.values], [
      { id: '1', op: 'clone' },
      { id: '2', op: 'close' },
    ]);
    assert.equal(second.rest.length, 0);
  }
});
