import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleDecryptedRequest } from '../src/node/drivers/ios/mitm-proxy.ts';
import { createUrlMapper, forwardedHeadersFor, toLocalHeaders } from '../src/node/override.ts';
import { detectPresetFromDependencies, PRESETS } from '../src/node/presets.ts';
import { corsHeaders, createVitalsHandler } from '../src/rum/server.ts';

const REMOTE = 'https://stand.example.test';
const LOCAL = 'http://localhost:3000';

describe('RUM handlers CORS (allowOrigin)', () => {
    const vital = JSON.stringify({ name: 'LCP', value: 900, rating: 'good', path: '/' });

    it('answers the preflight and tags responses only for allowed origins', async () => {
        const handler = createVitalsHandler({
            onMetric: () => undefined,
            allowOrigin: ['https://site.example'],
        });
        const preflight = await handler(
            new Request('https://api.example/api/vitals', {
                method: 'OPTIONS',
                headers: { origin: 'https://site.example' },
            }),
        );

        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://site.example');
        assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');

        const ok = await handler(
            new Request('https://api.example/api/vitals', {
                method: 'POST',
                headers: { origin: 'https://site.example', 'content-type': 'text/plain' },
                body: vital,
            }),
        );

        assert.equal(ok.status, 204);
        assert.equal(ok.headers.get('access-control-allow-origin'), 'https://site.example');

        const foreign = await handler(
            new Request('https://api.example/api/vitals', {
                method: 'OPTIONS',
                headers: { origin: 'https://evil.example' },
            }),
        );

        assert.equal(foreign.status, 405);
        assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    });

    it('supports "*" and predicates, and nothing when unset', () => {
        assert.deepEqual(corsHeaders('*', 'https://a.example'), {
            'access-control-allow-origin': 'https://a.example',
            vary: 'origin',
        });
        assert.deepEqual(
            corsHeaders((o) => o.endsWith('.example'), 'https://b.example')[
                'access-control-allow-origin'
            ],
            'https://b.example',
        );
        assert.deepEqual(corsHeaders(undefined, 'https://a.example'), {});
    });
});

describe('dev --forwarded (SSR reverse-proxy mode)', () => {
    const mapper = createUrlMapper({ remote: REMOTE, local: LOCAL, remoteBase: '/shop' });

    it('describes the stand to the SSR server', () => {
        assert.deepEqual(forwardedHeadersFor(mapper), {
            'x-forwarded-host': 'stand.example.test',
            'x-forwarded-proto': 'https',
            'x-forwarded-port': '443',
            forwarded: 'host="stand.example.test";proto=https',
            'x-forwarded-prefix': '/shop',
        });
    });

    it('Android: keeps Origin/Referer of the stand and adds X-Forwarded-*', () => {
        const headers = toLocalHeaders(
            { Origin: REMOTE, Referer: `${REMOTE}/shop/cart` },
            [],
            LOCAL,
            mapper.toLocal,
            forwardedHeadersFor(mapper),
        );

        assert.equal(headers.origin, REMOTE);
        assert.equal(headers.referer, `${REMOTE}/shop/cart`);
        assert.equal(headers['x-forwarded-host'], 'stand.example.test');
    });

    it('iOS MITM: same headers on intercepted requests', async () => {
        let sent: Record<string, string> = {};

        await handleDecryptedRequest({
            method: 'POST',
            url: '/shop/checkout',
            headers: { origin: REMOTE, host: 'stand.example.test' },
            mapper,
            forwardedHeaders: true,
            fetchImpl: async (_url, init) => {
                sent = init?.headers as Record<string, string>;

                return new Response(null, { status: 204 });
            },
        });

        assert.equal(sent.origin, REMOTE);
        assert.equal(sent['x-forwarded-proto'], 'https');
        assert.equal(sent['x-forwarded-prefix'], '/shop');
    });
});

describe('SvelteKit preset', () => {
    it('is detected before the generic vite preset', () => {
        assert.equal(
            detectPresetFromDependencies({ '@sveltejs/kit': '^2', vite: '^6' }),
            'sveltekit',
        );
        assert.deepEqual(PRESETS.sveltekit.wsPrefixes, ['/']);
    });
});
