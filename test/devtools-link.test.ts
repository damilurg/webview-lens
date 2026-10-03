import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    frontendPath,
    frontendRevision,
    handshakeForDevtools,
    stripCspMeta,
} from '../src/node/devtools-link.ts';

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
});
