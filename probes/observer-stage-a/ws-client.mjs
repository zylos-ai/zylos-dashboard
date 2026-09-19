import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';

const MAX_FRAME_BYTES = 1024 * 1024;

export class WsClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port, path, cookie }) {
    super();
    this.host = host;
    this.port = port;
    this.path = path;
    this.cookie = cookie;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.opened = false;
  }

  async connect(timeoutMs = 5000) {
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.setNoDelay(true);
    const connected = new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    await connected;
    this.socket.write([
      `GET ${this.path} HTTP/1.1`,
      `Host: ${this.host}:${this.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Cookie: ${this.cookie}`,
      '',
      '',
    ].join('\r\n'));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket handshake timed out: ${this.path}`)), timeoutMs);
      const onError = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const boundary = this.buffer.indexOf('\r\n\r\n');
        if (boundary === -1) return;
        const head = this.buffer.subarray(0, boundary).toString('latin1');
        this.buffer = this.buffer.subarray(boundary + 4);
        const lines = head.split('\r\n');
        const status = Number(lines[0].split(' ')[1]);
        const headers = new Map(lines.slice(1).map((line) => {
          const index = line.indexOf(':');
          return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }));
        if (status !== 101 || headers.get('sec-websocket-accept') !== expectedAccept) {
          clearTimeout(timer);
          reject(new Error(`WebSocket handshake rejected (${status}): ${this.path}`));
          return;
        }
        clearTimeout(timer);
        this.socket.off('error', onError);
        this.socket.off('data', onData);
        this.opened = true;
        this.socket.on('data', (data) => {
          this.buffer = Buffer.concat([this.buffer, data]);
          this.#drainFrames();
        });
        this.socket.on('error', (error) => this.emit('error', error));
        this.socket.on('close', () => this.emit('close'));
        this.#drainFrames();
        resolve();
      };
      this.socket.on('error', onError);
      this.socket.on('data', onData);
    });
    return this;
  }

  sendText(text) {
    const payload = Buffer.from(text);
    if (payload.length > MAX_FRAME_BYTES) throw new Error('outbound WebSocket frame too large');
    this.#sendFrame(0x1, payload);
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    if (this.opened) this.#sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
  }

  #sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('WebSocket is closed');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.allocUnsafe(payload.length);
    for (let index = 0; index < payload.length; index++) masked[index] = payload[index] ^ mask[index % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  #drainFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_FRAME_BYTES)) throw new Error('inbound WebSocket frame too large');
        length = Number(longLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) throw new Error('inbound WebSocket frame too large');
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      if (opcode === 0x8) {
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.#sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) throw new Error('unexpected continuation frame');
        this.fragments.push(payload);
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) throw new Error('interleaved fragmented frame');
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else {
        throw new Error(`unsupported WebSocket opcode ${opcode}`);
      }
      if (!fin) continue;
      const message = Buffer.concat(this.fragments);
      const messageOpcode = this.fragmentOpcode;
      this.fragmentOpcode = null;
      this.fragments = [];
      this.emit('message', messageOpcode === 0x1 ? message.toString('utf8') : message);
    }
  }
}
