//  A small WebSocket server side (RFC 6455) for streams the hub sends itself,
//  such as the live model (live.ts). Text from the hub; a client may send
//  short text messages back, each in one frame, and anything else it sends
//  beyond control frames is read and dropped.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const Guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
//  the most a client may send in one frame; it has little to say
export const MaxClientFrame = 4096;
const PingMs = 30_000;
const SilentMs = 75_000;
const ClosingMs = 2_000;

export interface WsPeer {
    readonly open: boolean;
    //  false if the peer has closed, or is too far behind to be sent more
    send(text: string): boolean;
    close(code?: number, reason?: string): void;
    onClose(handler: () => void): void;
    //  a whole text message from the client (fragmented ones are dropped)
    onText(handler: (text: string) => void): void;
    //  bytes waiting to be written: how far behind this peer is
    backlog(): number;
}

function frame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    const head =
        len < 126
            ? Buffer.from([0x80 | opcode, len])
            : len < 65536
              ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
              : Buffer.concat([Buffer.from([0x80 | opcode, 127]), u64(len)]);
    return Buffer.concat([head, payload]);
}

function u64(n: number): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
}

//  Whether a request is a WebSocket upgrade this server can accept
export function isUpgrade(req: IncomingMessage): boolean {
    return (
        'websocket' === String(req.headers.upgrade ?? '').toLowerCase() &&
        '13' === String(req.headers['sec-websocket-version'] ?? '') &&
        /^[A-Za-z0-9+/]{22}==$/.test(String(req.headers['sec-websocket-key'] ?? ''))
    );
}

//  Completes the handshake (call isUpgrade first) and returns the peer
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsPeer {
    const accept = createHash('sha1')
        .update(`${String(req.headers['sec-websocket-key'])}${Guid}`)
        .digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);

    let open = true;
    let buffer = Buffer.alloc(0);
    let heard = Date.now();
    const handlers: (() => void)[] = [];
    const listeners: ((text: string) => void)[] = [];
    const write = (opcode: number, payload: Buffer) => {
        if (open && !socket.destroyed) {
            socket.write(frame(opcode, payload));
        }
    };
    const finish = () => {
        if (!open) {
            return;
        }
        open = false;
        clearInterval(pinger);
        handlers.forEach(h => h());
    };
    const close = (code = 1000, reason = '') => {
        if (!open) {
            return;
        }
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code);
        payload.write(reason, 2);
        write(8, payload);
        finish();
        socket.end();
        setTimeout(() => socket.destroy(), ClosingMs).unref();
    };
    const pinger = setInterval(() => {
        if (Date.now() - heard > SilentMs) {
            finish();
            socket.destroy();
            return;
        }
        write(9, Buffer.alloc(0));
    }, PingMs);
    pinger.unref();

    const read = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (open && buffer.length >= 2) {
            const b0 = buffer[0] as number;
            const b1 = buffer[1] as number;
            const opcode = b0 & 0x0f;
            let len = b1 & 0x7f;
            let at = 2;
            if (!(b1 & 0x80)) {
                return close(1002, 'frames from a client are masked');
            }
            if (126 === len) {
                if (buffer.length < 4) {
                    return;
                }
                len = buffer.readUInt16BE(2);
                at = 4;
            } else if (127 === len) {
                if (buffer.length < 10) {
                    return;
                }
                const big = buffer.readBigUInt64BE(2);
                len = big > BigInt(MaxClientFrame) ? MaxClientFrame + 1 : Number(big);
                at = 10;
            }
            if (len > MaxClientFrame) {
                return close(1009, 'too large');
            }
            if (opcode >= 8 && (len > 125 || !(b0 & 0x80))) {
                return close(1002, 'bad control frame');
            }
            if (buffer.length < at + 4 + len) {
                return;
            }
            const mask = buffer.subarray(at, at + 4);
            const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + len));
            for (let i = 0; i < payload.length; i++) {
                payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
            }
            buffer = buffer.subarray(at + 4 + len);
            heard = Date.now();
            switch (opcode) {
                case 8:
                    return close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
                case 9:
                    write(10, payload);
                    break;
                case 1:
                    if (b0 & 0x80) {
                        const text = payload.toString('utf8');
                        listeners.forEach(l => l(text));
                    }
                    break;
                case 0:
                case 2:
                case 10:
                    break;
                default:
                    return close(1002, 'unknown frame');
            }
        }
    };
    socket.on('data', read);
    socket.on('error', () => {});
    //  the client went away without a close frame: don't hold its half open
    socket.on('end', () => {
        finish();
        socket.destroy();
    });
    socket.on('close', finish);
    if (head.length) {
        read(head);
    }

    return {
        get open() {
            return open;
        },
        send(text: string): boolean {
            if (!open) {
                return false;
            }
            write(1, Buffer.from(text));
            return true;
        },
        close,
        onClose(handler: () => void) {
            handlers.push(handler);
        },
        onText(handler: (text: string) => void) {
            listeners.push(handler);
        },
        backlog() {
            return socket.writableLength;
        },
    };
}
