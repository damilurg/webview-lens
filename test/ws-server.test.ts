import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    acceptWebSocketKey,
    buildWebSocketAcceptResponse,
    decodeWsFrames,
    encodeWsFrame,
} from '../src/node/ws-server.ts';

const maskPayload = (payload: Buffer, mask: Buffer): Buffer => {
    const out = Buffer.alloc(payload.length);

    for (let i = 0; i < payload.length; i += 1) {
        out[i] = payload[i]! ^ mask[i % 4]!;
    }

    return out;
};

const buildMaskedClientFrame = (text: string, opcode = 0x1): Buffer => {
    const raw = Buffer.from(text, 'utf8');
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const masked = maskPayload(raw, mask);

    if (raw.length < 126) {
        return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | raw.length]), mask, masked]);
    }
    const header = Buffer.alloc(4);

    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(raw.length, 2);

    return Buffer.concat([header, mask, masked]);
};

describe('RFC 6455 WebSocket framing', () => {
    it('computes the standard RFC 6455 Sec-WebSocket-Accept key', () => {
        // Official RFC 6455 Section 4.2.2 test vector.
        assert.equal(
            acceptWebSocketKey('dGhlIHNhbXBsZSBub25jZQ=='),
            's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
        );
        assert.match(
            buildWebSocketAcceptResponse('dGhlIHNhbXBsZSBub25jZQ=='),
            /^HTTP\/1\.1 101 Switching Protocols\r\n[\s\S]*Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n\r\n$/,
        );
    });

    it('round-trips small and medium (>126 bytes) unmasked frames and decodes masked browser frames across TCP splits', () => {
        const small = encodeWsFrame('hello');
        const mediumText = 'x'.repeat(500);
        const medium = encodeWsFrame(mediumText);
        const masked = buildMaskedClientFrame('{"id":1,"method":"Runtime.enable"}');
        const stream = Buffer.concat([small, medium, masked]);

        // Split mid-frame to verify remainder handling.
        const splitPoint = small.length + 100;
        const first = decodeWsFrames(stream.subarray(0, splitPoint));

        assert.equal(first.frames.length, 1);
        assert.equal(first.frames[0]?.payload.toString('utf8'), 'hello');

        const second = decodeWsFrames(
            Buffer.concat([first.remainder, stream.subarray(splitPoint)]),
        );

        assert.equal(second.frames.length, 2);
        assert.equal(second.remainder.length, 0);
        assert.equal(second.frames[0]?.payload.toString('utf8'), mediumText);
        assert.equal(
            second.frames[1]?.payload.toString('utf8'),
            '{"id":1,"method":"Runtime.enable"}',
        );
    });
});
