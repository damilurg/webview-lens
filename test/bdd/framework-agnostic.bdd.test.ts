import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { DevtoolsPage } from '../../src/node/cdp.ts';
import { startOverride } from '../../src/node/override.ts';
import { resolvePreset } from '../../src/node/presets.ts';
import { createFakeCdp as createBaseFakeCdp } from '../helpers/fake-cdp.ts';

const createFakeCdp = () => createBaseFakeCdp({ cookies: [{ name: 'sid', value: 'cookie-1' }] });

const PAGE: DevtoolsPage = {
    id: 'page-1',
    type: 'page',
    url: 'https://stand.example.test/shop/',
    title: 'Shop',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/page-1',
};

describe('Feature: Framework-agnostic frontend override & RUM', () => {
    describe('Scenario: Auto-detecting a Vite project applies Vite WS and quiet defaults', () => {
        it('Given a workspace with vite in devDependencies, When preset auto is resolved and override starts, Then WS bridges / and vite prebundle paths are quiet', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-vite-'));

            fs.writeFileSync(
                path.join(dir, 'package.json'),
                JSON.stringify({ devDependencies: { vite: '^6.0.0', react: '^19.0.0' } }),
            );

            const preset = resolvePreset('auto', dir);

            assert.equal(preset.name, 'vite');
            assert.deepEqual(preset.wsPrefixes, ['/']);

            const fake = createFakeCdp();
            const loggedRequests: string[] = [];
            const fetchedUrls: string[] = [];

            const session = await startOverride({
                page: { ...PAGE, url: 'https://stand.example.test/' },
                remote: 'https://stand.example.test',
                local: 'http://localhost:5173',
                wsPrefixes: preset.wsPrefixes,
                quietPrefixes: preset.quietPrefixes,
                connect: async () => fake.cdp,
                fetchImpl: async (input) => {
                    const url = String(input);

                    fetchedUrls.push(url);

                    return new Response(`// served ${url}`, {
                        status: 200,
                        headers: { 'content-type': 'application/javascript' },
                    });
                },
                logger: {
                    request: (line) => loggedRequests.push(line),
                    error: () => undefined,
                },
            });

            fake.emit('Fetch.requestPaused', {
                requestId: 'req-vite-dep',
                request: {
                    url: 'https://stand.example.test/node_modules/.vite/deps/react.js',
                    method: 'GET',
                    headers: {},
                },
            });
            fake.emit('Fetch.requestPaused', {
                requestId: 'req-app',
                request: {
                    url: 'https://stand.example.test/src/main.tsx',
                    method: 'GET',
                    headers: {},
                },
            });

            const fulfilled = await fake.waitForCalls('Fetch.fulfillRequest', 2);

            assert.equal(fulfilled.length, 2);
            assert.deepEqual(fetchedUrls, [
                'http://localhost:5173/node_modules/.vite/deps/react.js',
                'http://localhost:5173/src/main.tsx',
            ]);
            assert.equal(loggedRequests.length, 1);
            assert.match(loggedRequests[0] ?? '', /\/src\/main\.tsx/);

            session.close();
        });
    });

    describe('Scenario: Stand served under subpath /shop maps to local root /', () => {
        it('Given --remote-base /shop and --local-base /, When requests and redirects flow, Then URLs, Referer, and Location are rewritten cleanly', async () => {
            let receivedUrl = '';
            let receivedReferer = '';
            let receivedCookie = '';
            const fake = createFakeCdp();

            const session = await startOverride({
                page: PAGE,
                remote: 'https://stand.example.test',
                remoteBase: '/shop',
                local: 'http://localhost:5173',
                localBase: '/',
                connect: async () => fake.cdp,
                fetchImpl: async (input, init) => {
                    receivedUrl = String(input);
                    const headers = new Headers(init?.headers);

                    receivedReferer = headers.get('referer') ?? '';
                    receivedCookie = headers.get('cookie') ?? '';

                    return new Response(null, {
                        status: 302,
                        headers: { location: '/login' },
                    });
                },
                logger: { request: () => undefined, error: () => undefined },
            });

            const fetchEnable = fake.calls.find((c) => c.method === 'Fetch.enable');

            assert.deepEqual(fetchEnable?.params, {
                patterns: [
                    { urlPattern: 'https://stand.example.test/shop', requestStage: 'Request' },
                    {
                        urlPattern: 'https://stand.example.test/shop/*',
                        requestStage: 'Request',
                    },
                ],
            });

            fake.emit('Fetch.requestPaused', {
                requestId: 'req-redirect',
                request: {
                    url: 'https://stand.example.test/shop/checkout',
                    method: 'GET',
                    headers: { Referer: 'https://stand.example.test/shop/cart' },
                },
            });

            const [fulfill] = await fake.waitForCalls('Fetch.fulfillRequest', 1);
            const params = fulfill?.params as {
                responseCode: number;
                responseHeaders: { name: string; value: string }[];
            };

            assert.equal(receivedUrl, 'http://localhost:5173/checkout');
            assert.equal(receivedReferer, 'http://localhost:5173/cart');
            assert.equal(receivedCookie, 'sid=cookie-1');
            assert.equal(params.responseCode, 302);
            assert.ok(
                params.responseHeaders.some(
                    (h) => h.name === 'location' && h.value === '/shop/login',
                ),
            );

            session.close();
        });
    });

    describe('Scenario: SSE responses and bypass prefixes do not hang CDP Fetch', () => {
        it('Given a local SSE stream and a bypassed path, When requested, Then SSE cancels upstream body and aborts immediately while bypassed path continues to stand', async () => {
            let sseCanceled = false;
            const fake = createFakeCdp();
            const errors: string[] = [];

            const session = await startOverride({
                page: { ...PAGE, url: 'https://stand.example.test/' },
                remote: 'https://stand.example.test',
                local: 'http://localhost:5173',
                bypassPrefixes: ['/api/stream'],
                connect: async () => fake.cdp,
                fetchImpl: async () => {
                    const infiniteSse = new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('data: connected\n\n'));
                        },
                        cancel() {
                            sseCanceled = true;
                        },
                    });

                    return new Response(infiniteSse, {
                        status: 200,
                        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
                    });
                },
                logger: {
                    request: () => undefined,
                    error: (line) => errors.push(line),
                },
            });

            fake.emit('Fetch.requestPaused', {
                requestId: 'req-bypass',
                request: {
                    url: 'https://stand.example.test/api/stream/live',
                    method: 'GET',
                    headers: {},
                },
            });

            const [continued] = await fake.waitForCalls('Fetch.continueRequest', 1);

            assert.deepEqual(continued?.params, { requestId: 'req-bypass' });

            fake.emit('Fetch.requestPaused', {
                requestId: 'req-sse',
                request: {
                    url: 'https://stand.example.test/__hot',
                    method: 'GET',
                    headers: {},
                },
            });

            const [failed] = await fake.waitForCalls('Fetch.failRequest', 1);

            assert.deepEqual(failed?.params, {
                requestId: 'req-sse',
                errorReason: 'Aborted',
            });
            assert.equal(sseCanceled, true);
            assert.ok(errors.some((e) => /text\/event-stream|SSE/i.test(e)));

            session.close();
        });
    });
});
