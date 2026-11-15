import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { generateLeafCert, generateRootCa } from '../src/node/drivers/ios/certs.ts';
import { stripHopByHopHeaders } from '../src/node/override.ts';
import { encodeQrMatrix, evaluateQrPenalty } from '../src/node/qr.ts';
import {
    createWsFrameAssembler,
    decodeWsFrames,
    encodeCloseFrame,
    encodeWsFrame,
    WS_OPCODE_CONTINUATION,
    WS_OPCODE_PING,
    WS_OPCODE_TEXT,
} from '../src/node/ws-server.ts';
import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
} from '../src/rum/server.ts';

describe('ISO / RFC Conformance Suite', () => {
    describe('RFC 5280 / 5480 / 5758 — X.509 v3 Certificates (SKI, AKI, ECDSA KeyUsage)', () => {
        it('includes SubjectKeyIdentifier on CA and AuthorityKeyIdentifier matching CA SKI on leaf', () => {
            const ca = generateRootCa('RFC Test CA');
            const leaf = generateLeafCert('stand.example.test', ca);

            const caX509 = new crypto.X509Certificate(ca.certPem);
            const leafX509 = new crypto.X509Certificate(leaf.certPem);

            assert.equal(caX509.ca, true);
            assert.equal(leafX509.ca, false);
            assert.equal(leafX509.verify(caX509.publicKey), true);
            assert.equal(leafX509.checkHost('stand.example.test'), 'stand.example.test');

            // Node X509Certificate exposes `keyUsage` and raw DER containing OID 2.5.29.14 (SKI) & 2.5.29.35 (AKI)
            // DER encoding of OID 2.5.29.14 = 06 03 55 1d 0e; OID 2.5.29.35 = 06 03 55 1d 23
            const skiOid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0e]);
            const akiOid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x23]);

            assert.ok(
                caX509.raw.includes(skiOid),
                'Root CA MUST include SubjectKeyIdentifier (RFC 5280 §4.2.1.2)',
            );
            assert.ok(
                leafX509.raw.includes(skiOid),
                'Leaf cert SHOULD include SubjectKeyIdentifier',
            );
            assert.ok(
                leafX509.raw.includes(akiOid),
                'Leaf cert MUST include AuthorityKeyIdentifier (RFC 5280 §4.2.1.1)',
            );
        });
    });

    describe('RFC 6455 — WebSocket Fragmentation, Control Frames & Close Codes', () => {
        it('reassembles multi-frame fragmented text messages (§5.4) and rejects oversized messages with 1009', () => {
            const assembler = createWsFrameAssembler({ maxMessageBytes: 32 });
            // Fragment 1: FIN=0, opcode=TEXT ("hello ")
            const frag1 = Buffer.concat([Buffer.from([WS_OPCODE_TEXT, 6]), Buffer.from('hello ')]);
            // Interleaved control frame: PING (RFC 6455 §5.4 allows control frames between fragments!)
            const ping = encodeWsFrame('p', WS_OPCODE_PING);
            // Fragment 2: FIN=1, opcode=CONTINUATION ("world")
            const frag2 = Buffer.concat([
                Buffer.from([0x80 | WS_OPCODE_CONTINUATION, 5]),
                Buffer.from('world'),
            ]);

            const decoded = decodeWsFrames(Buffer.concat([frag1, ping, frag2]));

            assert.equal(decoded.frames.length, 3);

            const emitted: { opcode: number; text: string }[] = [];

            for (const frame of decoded.frames) {
                const msg = assembler.push(frame);

                if (msg) emitted.push({ opcode: msg.opcode, text: msg.payload.toString('utf8') });
            }

            assert.deepEqual(emitted, [
                { opcode: WS_OPCODE_PING, text: 'p' },
                { opcode: WS_OPCODE_TEXT, text: 'hello world' },
            ]);

            // Oversized message rejected with protocol error / 1009
            const huge = encodeWsFrame('x'.repeat(64));
            const [hugeFrame] = decodeWsFrames(huge).frames;

            assert.throws(() => assembler.push(hugeFrame!), /too large|1009/i);
        });

        it('rejects fragmented or >125-byte control frames (§5.5) and encodes valid Close frames (§5.5.1)', () => {
            const assembler = createWsFrameAssembler();

            assert.throws(
                () =>
                    assembler.push({
                        fin: false,
                        opcode: WS_OPCODE_PING,
                        payload: Buffer.from('hi'),
                    }),
                /Control frame must not be fragmented/i,
            );
            assert.throws(
                () =>
                    assembler.push({
                        fin: true,
                        opcode: WS_OPCODE_PING,
                        payload: Buffer.alloc(126),
                    }),
                /Control frame payload exceeds 125 bytes/i,
            );

            const closeBuf = encodeCloseFrame(1000, 'bye');
            const [closeFrame] = decodeWsFrames(closeBuf).frames;

            assert.equal(closeFrame?.payload.readUInt16BE(0), 1000);
            assert.equal(closeFrame?.payload.subarray(2).toString('utf8'), 'bye');
        });
    });

    describe('ISO/IEC 18004 — QR Code 8-Mask Penalty Optimization (§7.8.3)', () => {
        it('evaluates all 8 masks (0..7) and selects a valid mask with minimal penalty', () => {
            const url = 'http://192.168.1.42:8888/webview-lens.mobileconfig';
            const matrix = encodeQrMatrix(url);

            assert.ok(matrix.mask >= 0 && matrix.mask <= 7);
            assert.ok(evaluateQrPenalty(matrix) > 0);

            // Format info bits at (8, 0..5) + (8,7) + (8,8) + (7,8) + (5..0,8) must match the chosen mask's BCH(15,5)
            const expectedFormat = ((mask: number) => {
                const data = (0b01 << 3) | (mask & 0b111);
                let rem = data << 10;

                for (let i = 14; i >= 10; i -= 1) {
                    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
                }

                return ((data << 10) | rem) ^ 0x5412;
            })(matrix.mask);

            for (let i = 0; i <= 5; i += 1) {
                assert.equal(matrix.get(8, i), Boolean((expectedFormat >> (14 - i)) & 1));
            }
        });
    });

    describe('RFC 9110 — HTTP Semantics (Allow on 405 & Connection hop-by-hop headers)', () => {
        it('sets Allow header on 405 Method Not Allowed responses (§15.5.6)', async () => {
            const vitals = createVitalsHandler({ onMetric: () => undefined });
            const timings = createTimingsHandler({ onTiming: () => undefined });
            const logs = createClientLogHandler({ onLog: () => undefined });
            const metrics = createMetricsHandler(createRumAggregator());

            const getReq = new Request('https://app.example.test/api', { method: 'GET' });
            const postReq = new Request('https://app.example.test/metrics', { method: 'POST' });

            const r1 = await vitals(getReq);
            const r2 = await timings(getReq);
            const r3 = await logs(getReq);
            const r4 = await metrics(postReq);

            assert.equal(r1.status, 405);
            assert.equal(r1.headers.get('allow'), 'POST');
            assert.equal(r2.status, 405);
            assert.equal(r2.headers.get('allow'), 'POST');
            assert.equal(r3.status, 405);
            assert.equal(r3.headers.get('allow'), 'POST');
            assert.equal(r4.status, 405);
            assert.equal(r4.headers.get('allow'), 'GET');
        });

        it('strips standard hop-by-hop headers and custom headers nominated by Connection (§7.6.1)', () => {
            const cleaned = stripHopByHopHeaders({
                Connection: 'keep-alive, X-Custom-Hop',
                'Keep-Alive': 'timeout=5',
                'X-Custom-Hop': 'secret',
                'Content-Type': 'application/json',
                'X-App': 'ok',
            });

            assert.deepEqual(cleaned, {
                'Content-Type': 'application/json',
                'X-App': 'ok',
            });
        });
    });
});
