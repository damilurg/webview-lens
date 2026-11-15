import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createFrontendLoader,
    DEFAULT_FRONTEND_ORIGIN,
    stripCspMeta,
} from '../src/node/devtools-frontend.ts';
import { frontendPath, frontendRevision, handshakeForDevtools } from '../src/node/devtools-link.ts';

describe('DevTools link', () => {
    it('frontend path: our server, WebView revision, page socket through our port', () => {
        assert.equal(
            frontendPath('ABC', '3300', '1d17'),
            '/serve_rev/@1d17/inspector.html?ws=localhost:3300/devtools/page/ABC',
        );
    });

    it('handshake for the debugging port: no browser Origin, its own Host', () => {
        const handshake = handshakeForDevtools(
            {
                method: 'GET',
                url: '/devtools/page/ABC',
                headers: {
                    host: 'localhost:3300',
                    origin: 'http://localhost:3300',
                    upgrade: 'websocket',
                    'sec-websocket-key': 'k',
                },
            },
            '9223',
        );

        assert.ok(
            handshake.startsWith('GET /devtools/page/ABC HTTP/1.1\r\nhost: localhost:9223\r\n'),
        );
        assert.doesNotMatch(handshake, /origin/i);
        assert.ok(handshake.includes('sec-websocket-key: k\r\n'));
        assert.ok(handshake.endsWith('\r\n\r\n'));
    });

    it('revision from the page frontend URL', () => {
        const page = {
            devtoolsFrontendUrl:
                'https://devtools.example.test/serve_rev/@1d17a2/inspector.html?ws=x',
        };

        assert.equal(frontendRevision(page, {}), '1d17a2');
    });

    it('no URL: revision from WebKit-Version', () => {
        assert.equal(frontendRevision({}, { 'WebKit-Version': '537.36 (@abc123)' }), 'abc123');
    });

    it('neither: undefined, nothing to open', () => {
        assert.equal(frontendRevision({}, {}), undefined);
    });

    it('CSP <meta> is removed, the rest of the HTML stays', () => {
        const html =
            '<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="connect-src data:"></head>';

        assert.equal(stripCspMeta(html), '<head><meta charset="utf-8"></head>');
    });

    it('createFrontendLoader caches files, strips CSP from HTML, and supports custom mirror origins', async () => {
        const fetched: string[] = [];
        const load = createFrontendLoader({
            origin: 'https://devtools-mirror.corp.test/',
            fetchImpl: async (input) => {
                fetched.push(String(input));

                return new Response(
                    '<meta http-equiv="Content-Security-Policy" content="default-src none"><h1>UI</h1>',
                    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
                );
            },
        });

        assert.equal(DEFAULT_FRONTEND_ORIGIN, 'https://chrome-devtools-frontend.appspot.com');

        const first = await load('/serve_rev/@abc/inspector.html');
        const second = await load('/serve_rev/@abc/inspector.html');

        assert.equal(first.status, 200);
        assert.equal(first.body.toString('utf8'), '<h1>UI</h1>');
        assert.equal(second.body.toString('utf8'), '<h1>UI</h1>');
        assert.deepEqual(fetched, [
            'https://devtools-mirror.corp.test/serve_rev/@abc/inspector.html',
        ]);
    });
});
