import type vm from 'node:vm';
import type { BencodeValue } from './bencode.ts';

export interface NReplMessage {
  id: string;
  op: string;
  session?: string;
  code?: string;
}

export interface NReplResponse {
  id: string;
  session?: string;
  status?: string[];
  value?: string;
  err?: string;
  out?: string;
  'new-session'?: string;
  ops?: Record<string, BencodeValue>;
}

export interface ServerContext {
  sessions: Map<string, vm.Context>;
}

export const createServerContext = (): ServerContext => ({ sessions: new Map() });

const asString = (value: BencodeValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Narrow a decoded bencode value into an `NReplMessage`.
 * Returns `undefined` when the value is not a dictionary carrying an `op`.
 */
export const toNReplMessage = (value: BencodeValue): NReplMessage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const op = asString(value.op);
  if (op === undefined) return undefined;

  return {
    id: asString(value.id) ?? '',
    op,
    session: asString(value.session),
    code: asString(value.code),
  };
};

/** Drop undefined fields so a message or response can be bencoded. */
export const toBencodeDict = <T extends object>(msg: T): Record<string, BencodeValue> =>
  Object.fromEntries(
    Object.entries(msg).filter(([, value]) => value !== undefined),
  ) as Record<string, BencodeValue>;
