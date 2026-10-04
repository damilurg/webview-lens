import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    bridgeShim,
    createUrlMapper,
    isEventStream,
    normalizeBasePath,
    resolveHmrTarget,
    toLocalHeaders,
} from '../src/node/override.ts';

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
