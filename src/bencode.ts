/**
 * Bencode encoder / decoder.
 *
 * Supported types (as used by nREPL):
 *   - byte strings : `<length>:<contents>`
 *   - integers     : `i<value>e`
 *   - lists        : `l<items>e`
 *   - dictionaries : `d<key><value>...e`
 *
 * The decoder is incremental: `decodeAll` returns every complete value found in
 * the buffer together with the unconsumed remainder, so a TCP stream can be fed
 * to it chunk by chunk.
 */

export type BencodeValue =
  | string
  | number
  | BencodeValue[]
  | { [key: string]: BencodeValue };

export interface DecodeResult<T> {
  readonly value: T;
  readonly offset: number;
}

export interface DecodeAllResult {
  readonly values: readonly BencodeValue[];
  readonly rest: Buffer;
}

export class BencodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BencodeError';
  }
}

/** Thrown while decoding a value that is not fully contained in the buffer. */
export class IncompleteError extends BencodeError {
  constructor() {
    super('incomplete bencode value');
    this.name = 'IncompleteError';
  }
}

const CHAR_i = 0x69;
const CHAR_l = 0x6c;
const CHAR_d = 0x64;
const CHAR_e = 0x65;
const CHAR_colon = 0x3a;
const CHAR_0 = 0x30;
const CHAR_9 = 0x39;
const CHAR_minus = 0x2d;

export const encode = (value: BencodeValue): Buffer => {
  if (typeof value === 'string') {
    const payload = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${payload.length}:`, 'utf8'), payload]);
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new BencodeError(`cannot encode non-integer number: ${value}`);
    }
    return Buffer.from(`i${value}e`, 'utf8');
  }

  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l', 'utf8'),
      ...value.map(encode),
      Buffer.from('e', 'utf8'),
    ]);
  }

  if (value !== null && typeof value === 'object') {
    // Bencode requires dictionary keys to be sorted lexicographically.
    const keys = Object.keys(value).sort();
    const entries = keys.flatMap((key) => {
      const entry = value[key];
      return entry === undefined ? [] : [encode(key), encode(entry)];
    });
    return Buffer.concat([
      Buffer.from('d', 'utf8'),
      ...entries,
      Buffer.from('e', 'utf8'),
    ]);
  }

  throw new BencodeError(`unsupported value: ${String(value)}`);
};

const isDigit = (byte: number): boolean => byte >= CHAR_0 && byte <= CHAR_9;

const decodeString = (buf: Buffer, start: number): DecodeResult<string> => {
  const colon = buf.indexOf(CHAR_colon, start);
  if (colon === -1) throw new IncompleteError();

  const lengthText = buf.toString('utf8', start, colon);
  if (!/^\d+$/.test(lengthText)) {
    throw new BencodeError(`invalid string length: ${lengthText}`);
  }

  const length = Number(lengthText);
  const end = colon + 1 + length;
  if (end > buf.length) throw new IncompleteError();

  return { value: buf.toString('utf8', colon + 1, end), offset: end };
};

const decodeInteger = (buf: Buffer, start: number): DecodeResult<number> => {
  const end = buf.indexOf(CHAR_e, start);
  if (end === -1) throw new IncompleteError();

  const text = buf.toString('utf8', start + 1, end);
  if (!/^-?\d+$/.test(text)) {
    throw new BencodeError(`invalid integer: ${text}`);
  }

  return { value: Number(text), offset: end + 1 };
};

const decodeList = (buf: Buffer, start: number): DecodeResult<BencodeValue[]> => {
  const items: BencodeValue[] = [];
  let offset = start + 1;

  while (true) {
    if (offset >= buf.length) throw new IncompleteError();
    if (buf[offset] === CHAR_e) return { value: items, offset: offset + 1 };

    const item = decodeValue(buf, offset);
    items.push(item.value);
    offset = item.offset;
  }
};

const decodeDictionary = (
  buf: Buffer,
  start: number,
): DecodeResult<Record<string, BencodeValue>> => {
  const dict: Record<string, BencodeValue> = {};
  let offset = start + 1;

  while (true) {
    if (offset >= buf.length) throw new IncompleteError();
    if (buf[offset] === CHAR_e) return { value: dict, offset: offset + 1 };

    const key = decodeString(buf, offset);
    const entry = decodeValue(buf, key.offset);
    dict[key.value] = entry.value;
    offset = entry.offset;
  }
};

export const decodeValue = (buf: Buffer, start = 0): DecodeResult<BencodeValue> => {
  if (start >= buf.length) throw new IncompleteError();

  const byte = buf[start];
  if (byte === CHAR_i) return decodeInteger(buf, start);
  if (byte === CHAR_l) return decodeList(buf, start);
  if (byte === CHAR_d) return decodeDictionary(buf, start);
  if (isDigit(byte)) return decodeString(buf, start);
  if (byte === CHAR_minus) throw new BencodeError('unexpected "-" outside of integer');

  throw new BencodeError(`unexpected byte 0x${byte.toString(16)} at offset ${start}`);
};

/** Decode a single, fully contained bencode value. */
export const decode = (buf: Buffer): BencodeValue => {
  const { value, offset } = decodeValue(buf, 0);
  if (offset !== buf.length) {
    throw new BencodeError(`trailing data after value at offset ${offset}`);
  }
  return value;
};

/** Decode every complete value in `buf`, returning the undecodable remainder. */
export const decodeAll = (buf: Buffer): DecodeAllResult => {
  const values: BencodeValue[] = [];
  let offset = 0;

  while (offset < buf.length) {
    try {
      const result = decodeValue(buf, offset);
      values.push(result.value);
      offset = result.offset;
    } catch (err) {
      if (err instanceof IncompleteError) break;
      throw err;
    }
  }

  return { values, rest: buf.subarray(offset) };
};
