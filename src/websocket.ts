import crypto from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';

export interface WebSocketConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const header = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
    return Buffer.concat([Buffer.from(header), payload]);
  }
  if (payload.length <= 0xffff) {
    header.push(126);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length);
    return Buffer.concat([Buffer.from(header), length, payload]);
  }
  header.push(127);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(payload.length));
  return Buffer.concat([Buffer.from(header), length, payload]);
};

class ServerWebSocketConnection implements WebSocketConnection {
  private readonly messageCallbacks: ((text: string) => void)[] = [];
  private readonly closeCallbacks: (() => void)[] = [];
  private readonly socket: Duplex;
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragmentedOpcode: number | undefined;
  private fragmentedPayload: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.once('error', () => this.fireClose());
    socket.once('close', () => this.fireClose());
  }

  send(text: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    let payload = Buffer.alloc(0);
    if (code !== undefined) {
      const reasonPayload = Buffer.from(reason ?? '', 'utf8');
      payload = Buffer.alloc(2 + reasonPayload.length);
      payload.writeUInt16BE(code);
      reasonPayload.copy(payload, 2);
    }
    this.socket.write(encodeFrame(0x8, payload), () => this.socket.end());
    this.fireClose();
  }

  onMessage(cb: (text: string) => void): void {
    this.messageCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  private receive(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (true) {
      const frame = this.readFrame();
      if (!frame) return;
      this.handleFrame(frame.opcode, frame.fin, frame.payload);
    }
  }

  private readFrame():
    | { opcode: number; fin: boolean; payload: Buffer }
    | undefined {
    if (this.buffered.length < 2) return undefined;

    const first = this.buffered[0] ?? 0;
    const second = this.buffered[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const lengthCode = second & 0x7f;
    let offset = 2;
    let length: number;

    if (lengthCode < 126) {
      length = lengthCode;
    } else if (lengthCode === 126) {
      if (this.buffered.length < offset + 2) return undefined;
      length = this.buffered.readUInt16BE(offset);
      offset += 2;
    } else {
      if (this.buffered.length < offset + 8) return undefined;
      const largeLength = this.buffered.readBigUInt64BE(offset);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.socket.destroy();
        return undefined;
      }
      length = Number(largeLength);
      offset += 8;
    }

    if (!masked) {
      this.socket.destroy();
      return undefined;
    }
    if (this.buffered.length < offset + 4 + length) return undefined;

    const mask = this.buffered.subarray(offset, offset + 4);
    offset += 4;
    const payload: Buffer<ArrayBufferLike> = Buffer.from(
      this.buffered.subarray(offset, offset + length),
    );
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    this.buffered = this.buffered.subarray(offset + length);
    return { opcode, fin, payload };
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x9) {
      if (!this.closed) this.socket.write(encodeFrame(0xa, payload));
      return;
    }
    if (opcode === 0x8) {
      if (!this.closed) this.socket.write(encodeFrame(0x8, payload), () => this.socket.end());
      this.fireClose();
      return;
    }
    if (opcode === 0x2) return;

    if (opcode === 0x1) {
      if (this.fragmentedOpcode !== undefined) return;
      if (fin) {
        this.emitMessage(payload);
      } else {
        this.fragmentedOpcode = opcode;
        this.fragmentedPayload = payload;
      }
      return;
    }
    if (opcode === 0x0 && this.fragmentedOpcode !== undefined) {
      this.fragmentedPayload = Buffer.concat([this.fragmentedPayload, payload]);
      if (fin) {
        if (this.fragmentedOpcode === 0x1) this.emitMessage(this.fragmentedPayload);
        this.fragmentedOpcode = undefined;
        this.fragmentedPayload = Buffer.alloc(0);
      }
    }
  }

  private emitMessage(payload: Buffer): void {
    const text = payload.toString('utf8');
    this.messageCallbacks.forEach((callback) => callback(text));
  }

  private fireClose(): void {
    if (this.closed) {
      if (this.closeCallbacks.length === 0) return;
    } else {
      this.closed = true;
    }
    const callbacks = this.closeCallbacks.splice(0);
    callbacks.forEach((callback) => callback());
  }
}

export const attachWebSocketServer = (
  httpServer: http.Server,
  onConnection: (conn: WebSocketConnection) => void,
  path?: string,
): void => {
  httpServer.on('upgrade', (request, socket) => {
    const requestPath = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    if (path !== undefined && requestPath !== path) {
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    onConnection(new ServerWebSocketConnection(socket));
  });
};
