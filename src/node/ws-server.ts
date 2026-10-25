// Minimal RFC 6455 WebSocket handshake and frame codec for local DevTools bridges (zero deps).

import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_OPCODE_CONTINUATION = 0x0;
export const WS_OPCODE_TEXT = 0x1;
export const WS_OPCODE_BINARY = 0x2;
export const WS_OPCODE_CLOSE = 0x8;
export const WS_OPCODE_PING = 0x9;
export const WS_OPCODE_PONG = 0xa;

export interface WsFrame {
    fin: boolean;
    opcode: number;
    payload: Buffer;
}

/** Computes the RFC 6455 `Sec-WebSocket-Accept` header value. */
export const acceptWebSocketKey = (key: string): string =>
    crypto.createHash('sha1').update(`${key.trim()}${WS_GUID}`).digest('base64');

/** Builds the raw HTTP/1.1 101 Switching Protocols upgrade response. */
export const buildWebSocketAcceptResponse = (key: string): string =>
    [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptWebSocketKey(key)}`,
        '',
        '',
    ].join('\r\n');

/** Encodes a server-to-client (unmasked) RFC 6455 WebSocket frame. */
export const encodeWsFrame = (data: string | Buffer, opcode = WS_OPCODE_TEXT): Buffer => {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const len = payload.length;
    let header: Buffer;

    if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 0xffff) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
};

/** Decodes zero or more RFC 6455 frames from a stream buffer, returning any trailing fragment. */
export const decodeWsFrames = (buffer: Buffer): { frames: WsFrame[]; remainder: Buffer } => {
    const frames: WsFrame[] = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const b0 = buffer[offset]!;
        const b1 = buffer[offset + 1]!;
        const fin = Boolean(b0 & 0x80);
        const opcode = b0 & 0x0f;
        const masked = Boolean(b1 & 0x80);
        let payloadLen = b1 & 0x7f;
        let headerLen = 2;

        if (payloadLen === 126) {
            if (offset + 4 > buffer.length) break;
            payloadLen = buffer.readUInt16BE(offset + 2);
            headerLen = 4;
        } else if (payloadLen === 127) {
            if (offset + 10 > buffer.length) break;
            payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
            headerLen = 10;
        }

        const maskLen = masked ? 4 : 0;
        const frameLen = headerLen + maskLen + payloadLen;

        if (offset + frameLen > buffer.length) break;

        const payloadStart = offset + headerLen + maskLen;
        let payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLen));

        if (masked) {
            const maskStart = offset + headerLen;

            for (let i = 0; i < payload.length; i += 1) {
                payload[i] = payload[i]! ^ buffer[maskStart + (i % 4)]!;
            }
        }

        frames.push({ fin, opcode, payload });
        offset += frameLen;
    }

    return { frames, remainder: buffer.subarray(offset) };
};
