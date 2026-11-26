// connectCdp against a real local WebSocket server (Node's global WebSocket on the client side, the
// library's own RFC 6455 frame helpers on the server side).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { after, before, describe, it } from 'node:test';

import { connectCdp } from '../src/node/cdp.ts';
import {
    buildWebSocketAcceptResponse,
    decodeWsFrames,
    encodeCloseFrame,
    encodeWsFrame,
    WS_OPCODE_CLOSE,
    WS_OPCODE_TEXT,
} from '../src/node/ws-server.ts';

/** A fake page: answers commands by method, can push events and raw frames, can hang up. */
const startFakePage = () => {
    const server = http.createServer();
    const sockets = new Set<Duplex>();
    let client: Duplex | undefined;

    server.on('upgrade', (req, socket) => {
        sockets.add(socket);
        client = socket;
        socket.on('error', () => undefined);
        socket.write(buildWebSocketAcceptResponse(String(req.headers['sec-websocket-key'])));

        let pending: Buffer = Buffer.alloc(0);

        socket.on('data', (chunk: Buffer) => {
            const { frames, remainder } = decodeWsFrames(Buffer.concat([pending, chunk]));

            pending = remainder;
            for (const frame of frames) {
                // RFC 6455 §5.5.1: answer a close frame, or the client waits for one.
                if (frame.opcode === WS_OPCODE_CLOSE) {
                    socket.end(encodeCloseFrame());

                    return;
                }
                if (frame.opcode !== WS_OPCODE_TEXT) continue;

                const { id, method } = JSON.parse(frame.payload.toString('utf8'));
                const reply =
                    method === 'Broken.method'
                        ? { id, error: { code: -32601, message: "'Broken.method' wasn't found" } }
                        : { id, result: { echoed: method } };

                if (!socket.writableEnded) socket.write(encodeWsFrame(JSON.stringify(reply)));
            }
        });
    });

    return {
        server,
        send: (text: string) => {
            if (client && !client.writableEnded) client.write(encodeWsFrame(text));
        },
        hangUp: () => client?.end(encodeCloseFrame()),
        destroyAll: () => {
            for (const socket of sockets) socket.destroy();
        },
    };
};

describe('connectCdp over a real WebSocket', () => {
    const page = startFakePage();
    let url = '';

    before(async () => {
        await new Promise<void>((resolve) => page.server.listen(0, '127.0.0.1', resolve));
        url = `ws://127.0.0.1:${(page.server.address() as AddressInfo).port}/devtools/page/1`;
    });
    after(() => {
        page.destroyAll();
        page.server.close();
    });

    it('resolves command results and rejects protocol errors with their message', async () => {
        const cdp = await connectCdp(url);

        assert.deepEqual(await cdp.send('Runtime.enable'), { echoed: 'Runtime.enable' });
        await assert.rejects(cdp.send('Broken.method'), /'Broken\.method' wasn't found/);
        cdp.close();
        await cdp.closed;
    });

    it('delivers events to subscribers and once(), and survives malformed frames', async () => {
        const cdp = await connectCdp(url);
        const seen: unknown[] = [];
        const off = cdp.on('Page.loadEventFired', (params) => seen.push(params));
        const once = cdp.once('Page.frameNavigated');

        page.send('{ not json');
        page.send('[1, 2, 3]');
        page.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }));
        page.send(
            JSON.stringify({
                method: 'Page.frameNavigated',
                params: { frame: { url: 'https://a/' } },
            }),
        );

        assert.deepEqual(await once, { frame: { url: 'https://a/' } });
        assert.deepEqual(seen, [{ timestamp: 1 }]);

        off();
        page.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 2 } }));
        assert.deepEqual(await cdp.send('Runtime.evaluate'), { echoed: 'Runtime.evaluate' });
        assert.deepEqual(seen, [{ timestamp: 1 }]);
        cdp.close();
        await cdp.closed;
    });

    it('settles closed and rejects new commands when the page hangs up', async () => {
        const cdp = await connectCdp(url);

        page.hangUp();
        await cdp.closed;
        await assert.rejects(cdp.send('Runtime.enable'), /DevTools connection closed/);
    });

    it('explains a refused connection', async () => {
        const closed = http.createServer();

        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));

        const { port } = closed.address() as AddressInfo;

        closed.close();
        await assert.rejects(
            connectCdp(`ws://127.0.0.1:${port}/devtools/page/1`),
            /Cannot connect to DevTools/,
        );
    });
});
