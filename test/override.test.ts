import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    bridgeShim,
    createUrlMapper,
    isEventStream,
    normalizeBasePath,
    resolveHmrTarget,
    toLocalHeaders,
    startOverride,
} from '../src/node/override.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildWebSocketAcceptResponse } from '../src/node/ws-server.ts';
import { createFakeCdp } from './helpers/fake-cdp.ts';

const REMOTE = 'https://stand.example.test';
const LOCAL = 'http://localhost:3000';
const toLocal = (url: string) => LOCAL + url.slice(REMOTE.length);

describe('toLocalHeaders', () => {
    it('sends the stand cookies and rewrites Origin and Referer to the local server', () => {
        const headers = toLocalHeaders(
            {
                Accept: 'text/html',
                Origin: REMOTE,
                Referer: `${REMOTE}/events?q=1`,
                Cookie: 'stale=1',
                Host: 'stand.example.test',
                'Accept-Encoding': 'br',
            },
            [
                { name: 'session', value: 'abc' },
                { name: 'theme', value: 'dark' },
            ],
            LOCAL,
            toLocal,
        );

        assert.deepEqual(headers, {
            Accept: 'text/html',
            cookie: 'session=abc; theme=dark',
            origin: LOCAL,
            referer: `${LOCAL}/events?q=1`,
        });
    });

    it('no cookies, Origin or Referer: none are added', () => {
        assert.deepEqual(toLocalHeaders({ Accept: '*/*' }, [], LOCAL, toLocal), { Accept: '*/*' });
    });
});

describe('bridgeShim', () => {
    it('is valid JavaScript and bridges only the given prefixes on the ws origin', () => {
        const shim = bridgeShim(REMOTE, ['/_next/', '/socket']);

        assert.doesNotThrow(() => new Function(shim));
        assert.ok(shim.includes('"wss://stand.example.test/_next/"'));
        assert.ok(shim.includes('"wss://stand.example.test/socket"'));
    });

    it('also bridges configured separate HMR ports on localhost and 127.0.0.1', () => {
        const shim = bridgeShim(REMOTE, ['/'], [24678]);

        assert.doesNotThrow(() => new Function(shim));
        assert.ok(shim.includes('"ws://localhost:24678"'));
        assert.ok(shim.includes('"wss://localhost:24678"'));
        assert.ok(shim.includes('"ws://127.0.0.1:24678"'));
        assert.ok(shim.includes('"wss://127.0.0.1:24678"'));
    });
});

describe('normalizeBasePath & createUrlMapper', () => {
    it('normalizes root and trailing slashes', () => {
        assert.equal(normalizeBasePath(''), '');
        assert.equal(normalizeBasePath('/'), '');
        assert.equal(normalizeBasePath('shop/'), '/shop');
        assert.equal(normalizeBasePath('/shop/v2/'), '/shop/v2');
    });

    it('maps remote subpath to local root and rewrites absolute and root-relative Locations', () => {
        const mapper = createUrlMapper({
            remote: REMOTE,
            remoteBase: '/shop/',
            local: LOCAL,
            localBase: '/',
        });

        assert.equal(mapper.toLocal(`${REMOTE}/shop`), `${LOCAL}/`);
        assert.equal(mapper.toLocal(`${REMOTE}/shop/cart?x=1`), `${LOCAL}/cart?x=1`);
        assert.equal(mapper.toLocal(`${REMOTE}/shop-other`), `${REMOTE}/shop-other`);
        assert.equal(mapper.toRemote(`${LOCAL}/login`), `${REMOTE}/shop/login`);
        assert.equal(mapper.toRemote('/login?next=1'), '/shop/login?next=1');
        assert.equal(mapper.toRemote('//cdn.example.test/a'), '//cdn.example.test/a');
    });

    it('maps remote root to local subpath', () => {
        const mapper = createUrlMapper({
            remote: REMOTE,
            remoteBase: '/',
            local: LOCAL,
            localBase: '/preview',
        });

        assert.equal(mapper.toLocal(`${REMOTE}/cart`), `${LOCAL}/preview/cart`);
        assert.equal(mapper.toRemote(`${LOCAL}/preview/cart`), `${REMOTE}/cart`);
        assert.equal(mapper.toRemote('/preview/login'), '/login');
    });
});

describe('isEventStream', () => {
    it('detects text/event-stream case-insensitively with parameters', () => {
        assert.equal(isEventStream('text/event-stream'), true);
        assert.equal(isEventStream('TEXT/EVENT-STREAM; charset=utf-8'), true);
        assert.equal(isEventStream('application/json'), false);
        assert.equal(isEventStream(null), false);
    });
});

describe('resolveHmrTarget', () => {
    it('routes localhost/127.0.0.1 URLs on configured HMR ports directly to ws://', () => {
        assert.deepEqual(resolveHmrTarget('https://localhost:24678/hmr?t=1', [24678]), {
            wsUrl: 'ws://localhost:24678/hmr?t=1',
            origin: 'http://localhost:24678',
        });
        assert.deepEqual(resolveHmrTarget('http://127.0.0.1:24678/', [24678]), {
            wsUrl: 'ws://127.0.0.1:24678/',
            origin: 'http://127.0.0.1:24678',
        });
        assert.equal(resolveHmrTarget('https://stand.example.test/', [24678]), null);
        assert.equal(resolveHmrTarget('http://localhost:9999/', [24678]), null);
    });
});

const PAGE = {
    id: 'p1',
    type: 'page',
    url: 'https://stand.example.test/',
    title: 'Stand',
    webSocketDebuggerUrl: 'ws://fake',
};

describe('override WebSocket bridge binding', () => {
    it('ignores malformed payloads and refuses sockets outside the stand origin / HMR ports', async () => {
        const fake = createFakeCdp();

        await startOverride({
            page: PAGE,
            remote: 'https://stand.example.test',
            local: 'http://localhost:3000',
            connect: async () => fake.cdp,
            fetchImpl: async () => new Response(''),
            logger: { request: () => undefined, error: () => undefined },
        });

        const name = '__webviewLensWsSend';

        assert.doesNotThrow(() =>
            fake.emit('Runtime.bindingCalled', { name, payload: '{not json' }),
        );

        fake.emit('Runtime.bindingCalled', {
            name,
            payload: JSON.stringify({ sid: 7, type: 'open', url: 'http://127.0.0.1:6379/' }),
        });

        const calls = await fake.waitForCalls('Runtime.evaluate', 3);
        const expressions = calls.map((c) =>
            String((c.params as { expression?: string }).expression),
        );

        assert.ok(expressions.some((e) => e.includes('(7, "error"')));
    });
});

describe('dev WebSocket bridge subprotocols (Vite HMR)', () => {
    it('forwards the page subprotocol, so servers that require one (vite-hmr) accept the socket', async () => {
        const offered: string[] = [];
        const upgraded = new Set<import('node:stream').Duplex>();
        const server = http.createServer();

        server.on('upgrade', (req, socket) => {
            upgraded.add(socket);
            const protocol = String(req.headers['sec-websocket-protocol'] ?? '');

            offered.push(protocol);
            // Like Vite: only 'vite-hmr' is upgraded, anything else is dropped.
            if (protocol !== 'vite-hmr') {
                socket.destroy();

                return;
            }
            socket.write(
                buildWebSocketAcceptResponse(String(req.headers['sec-websocket-key'])).replace(
                    '\r\n\r\n',
                    '\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n',
                ),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

        const port = (server.address() as AddressInfo).port;
        const fake = createFakeCdp();

        try {
            await startOverride({
                page: PAGE,
                remote: 'https://stand.example.test',
                local: `http://127.0.0.1:${port}`,
                connect: async () => fake.cdp,
                fetchImpl: async () => new Response(''),
                logger: { request: () => undefined, error: () => undefined },
            });

            assert.match(
                bridgeShim('https://stand.example.test', ['/']),
                /new Bridged\(args\[0\], args\[1\]\)/,
            );

            fake.emit('Runtime.bindingCalled', {
                name: '__webviewLensWsSend',
                payload: JSON.stringify({
                    sid: 3,
                    type: 'open',
                    url: 'https://stand.example.test/?token=abc',
                    protocols: ['vite-hmr'],
                }),
            });

            const deadline = Date.now() + 3000;
            let opened = false;

            while (!opened && Date.now() < deadline) {
                opened = fake.calls.some((c) =>
                    String((c.params as { expression?: string }).expression).includes(
                        '(3, "open", "vite-hmr"',
                    ),
                );
                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            assert.deepEqual(offered, ['vite-hmr']);
            assert.ok(opened, 'the page is told the socket opened with the negotiated subprotocol');
        } finally {
            fake.cdp.close();
            // Upgraded sockets leave the server's bookkeeping: close them explicitly.
            for (const socket of upgraded) socket.destroy();
            server.close();
        }
    });
});
