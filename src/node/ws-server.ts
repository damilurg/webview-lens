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

const encodeWsHeader = (opcode: number, len: number): Buffer => {
    if (len < 126) return Buffer.from([0x80 | opcode, len]);

    if (len <= 0xffff) {
        const header = Buffer.alloc(4);

        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);

        return header;
    }

    const header = Buffer.alloc(10);

    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);

    return header;
};

/** Encodes a server-to-client (unmasked) RFC 6455 WebSocket frame. */
export const encodeWsFrame = (data: string | Buffer, opcode = WS_OPCODE_TEXT): Buffer => {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

    return Buffer.concat([encodeWsHeader(opcode, payload.length), payload]);
};

const readWsPayloadLength = (
    buffer: Buffer,
    offset: number,
    initialLen: number,
): { payloadLen: number; headerLen: number } | null => {
    if (initialLen < 126) return { payloadLen: initialLen, headerLen: 2 };
    if (initialLen === 126) {
        if (offset + 4 > buffer.length) return null;

        return { payloadLen: buffer.readUInt16BE(offset + 2), headerLen: 4 };
    }
    if (offset + 10 > buffer.length) return null;

    return { payloadLen: Number(buffer.readBigUInt64BE(offset + 2)), headerLen: 10 };
};

/** Decodes zero or more RFC 6455 frames from a stream buffer, returning any trailing fragment. */
export const decodeWsFrames = (buffer: Buffer): { frames: WsFrame[]; remainder: Buffer } => {
    const frames: WsFrame[] = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const b0 = buffer.readUInt8(offset);
        const b1 = buffer.readUInt8(offset + 1);
        const fin = Boolean(b0 & 0x80);
        const opcode = b0 & 0x0f;
        const masked = Boolean(b1 & 0x80);
        const parsedLen = readWsPayloadLength(buffer, offset, b1 & 0x7f);

        if (!parsedLen) break;

        const { payloadLen, headerLen } = parsedLen;
        const maskLen = masked ? 4 : 0;
        const frameLen = headerLen + maskLen + payloadLen;

        if (offset + frameLen > buffer.length) break;

        const payloadStart = offset + headerLen + maskLen;
        const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLen));

        if (masked) {
            const maskStart = offset + headerLen;

            for (let i = 0; i < payload.length; i += 1) {
                payload.writeUInt8(payload.readUInt8(i) ^ buffer.readUInt8(maskStart + (i % 4)), i);
            }
        }

        frames.push({ fin, opcode, payload });
        offset += frameLen;
    }

    return { frames, remainder: buffer.subarray(offset) };
};

/** Encodes an RFC 6455 §5.5.1 Close frame with a 2-byte big-endian status code and optional reason. */
export const encodeCloseFrame = (code = 1000, reason = ''): Buffer => {
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);

    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);

    return encodeWsFrame(payload, WS_OPCODE_CLOSE);
};

export interface WsMessage {
    opcode: number;
    payload: Buffer;
}

export interface WsFrameAssemblerOptions {
    /** Maximum reassembled message size in bytes (guards against OOM). Default: 16 MiB. */
    maxMessageBytes?: number;
}

export interface WsFrameAssembler {
    push(frame: WsFrame): WsMessage | null;
}

/**
 * Reassembles RFC 6455 §5.4 fragmented messages, enforces §5.5 control frame rules
 * (`FIN=1`, payload <= 125 bytes), and caps message size (§7.4.1 code 1009).
 */
export const createWsFrameAssembler = ({
    maxMessageBytes = 16 * 1024 * 1024,
}: WsFrameAssemblerOptions = {}): WsFrameAssembler => {
    let activeOpcode: number | null = null;
    let chunks: Buffer[] = [];
    let activeSize = 0;

    return {
        push(frame: WsFrame): WsMessage | null {
            const isControl = frame.opcode >= 0x8;

            if (isControl) {
                if (!frame.fin)
                    throw new Error('RFC 6455 §5.5: Control frame must not be fragmented');
                if (frame.payload.length > 125) {
                    throw new Error('RFC 6455 §5.5: Control frame payload exceeds 125 bytes');
                }

                return { opcode: frame.opcode, payload: frame.payload };
            }

            if (frame.opcode === WS_OPCODE_CONTINUATION) {
                if (activeOpcode === null) {
                    throw new Error('RFC 6455 §5.4: Unexpected continuation frame (1002)');
                }
                activeSize += frame.payload.length;
                if (activeSize > maxMessageBytes) {
                    activeOpcode = null;
                    chunks = [];
                    activeSize = 0;
                    throw new Error('RFC 6455: Message too large (1009)');
                }
                chunks.push(frame.payload);
                if (!frame.fin) return null;

                const message = { opcode: activeOpcode, payload: Buffer.concat(chunks) };

                activeOpcode = null;
                chunks = [];
                activeSize = 0;

                return message;
            }

            if (activeOpcode !== null) {
                throw new Error(
                    'RFC 6455 §5.4: New data frame started before previous message finished (1002)',
                );
            }
            if (frame.payload.length > maxMessageBytes) {
                throw new Error('RFC 6455: Message too large (1009)');
            }
            if (frame.fin) {
                return { opcode: frame.opcode, payload: frame.payload };
            }

            activeOpcode = frame.opcode;
            chunks = [frame.payload];
            activeSize = frame.payload.length;

            return null;
        },
    };
};
