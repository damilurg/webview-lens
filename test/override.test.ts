import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bridgeShim, toLocalHeaders } from '../src/node/override.ts';

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
});
