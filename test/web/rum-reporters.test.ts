// Browser RUM reporters (src/rum/index.ts), type-checked against the DOM (tsconfig.web-test.json).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    beaconTransport,
    captureGlobalErrors,
    createTimingReporter,
    createVitalsReporter,
    detectWebViewEnv,
    isCrossOriginEndpoint,
    isServerRuntime,
} from '../../src/rum/index.ts';
import {
    createTimingsHandler,
    createVitalsHandler,
    type NodeIncomingMessage,
    type NodeServerResponse,
    type TimingMetric,
    toNodeHandler,
    type VitalMetric,
} from '../../src/rum/server.ts';

const createFakeNodeRequest = (
    method: string,
    url: string,
    headers: Record<string, string>,
    chunks: string[] = [],
): NodeIncomingMessage => ({
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield Buffer.from(chunk);
    },
});

const createFakeNodeResponse = () => {
    const headers = new Map<string, string>();
    let endedBody: Uint8Array | string | undefined;
    const res: NodeServerResponse = {
        statusCode: 200,
        setHeader: (name, value) => headers.set(name.toLowerCase(), value),
        end: (chunk) => {
            endedBody = chunk;
        },
    };

    return { res, headers, body: () => endedBody };
};

describe('RUM client during SSR / SSG prerender', () => {
    it('is a no-op on the server instead of throwing or fetching relative URLs', () => {
        const realFetch = globalThis.fetch;
        let fetched = 0;

        globalThis.fetch = (async () => {
            fetched += 1;

            return new Response(null);
        }) as typeof fetch;
        try {
            assert.equal(isServerRuntime(), true);
            assert.doesNotThrow(() => captureGlobalErrors(() => undefined)());
            beaconTransport('/api/vitals', '{}');
            createVitalsReporter()({ name: 'LCP', value: 1000 });
            assert.equal(fetched, 0);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('detects cross-origin endpoints (SSG on a CDN posting to an API host)', () => {
        assert.equal(isCrossOriginEndpoint('/api/vitals', 'https://site.example/p'), false);
        assert.equal(
            isCrossOriginEndpoint('https://api.example/vitals', 'https://site.example/p'),
            true,
        );
        assert.equal(isCrossOriginEndpoint('/api/vitals', ''), false);
    });
});

describe('Feature: RUM reporters in WebView pages', () => {
    describe('Scenario: Framework-agnostic RUM supports :param routes over a standard Node HTTP handler', () => {
        it('Given a React/Vue router template /event/:id and toNodeHandler, When a vital is reported, Then the server accepts 204 with the preserved template', async () => {
            const received: VitalMetric[] = [];
            const nodeHandler = toNodeHandler(
                createVitalsHandler({
                    onMetric: (metric) => {
                        received.push(metric);
                    },
                }),
            );

            let pending: Promise<void> | undefined;
            const response = createFakeNodeResponse();
            const report = createVitalsReporter({
                endpoint: '/api/vitals',
                path: () => '/event/:id/details?tab=2',
                transport: (endpoint, body) => {
                    const req = createFakeNodeRequest(
                        'POST',
                        endpoint,
                        { host: 'app.example.test', 'content-type': 'application/json' },
                        [body],
                    );

                    pending = nodeHandler(req, response.res);
                },
            });

            report({ name: 'LCP', value: 1450, rating: 'good' });
            await pending;

            assert.equal(response.res.statusCode, 204);
            assert.deepEqual(received, [
                { name: 'LCP', value: 1450, rating: 'good', path: '/event/:id/details' },
            ]);
        });
    });

    describe('Scenario: Production RUM carries WebView context tags and custom bridge timings', () => {
        it('Given Android WebView UA and custom context, When vitals and custom timings are reported, Then server handlers validate and deliver checked context and timings', async () => {
            const env = detectWebViewEnv(
                'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
            );

            assert.equal(env, 'android-webview');

            const vitals: VitalMetric[] = [];
            const timings: TimingMetric[] = [];
            const vitalsHandler = createVitalsHandler({
                onMetric: (m) => void vitals.push(m),
            });
            const timingsHandler = createTimingsHandler({
                onTiming: (t) => void timings.push(t),
            });

            const pending: Promise<Response>[] = [];
            const sendTo =
                (handler: (req: Request) => Promise<Response>) =>
                (endpoint: string, body: string) => {
                    pending.push(
                        handler(
                            new Request(`https://app.example.test${endpoint}`, {
                                method: 'POST',
                                body,
                                headers: { 'content-type': 'application/json' },
                            }),
                        ),
                    );
                };

            const reportVital = createVitalsReporter({
                path: () => '/checkout/:step',
                context: () => ({ appVersion: '5.12.0', env }),
                transport: sendTo(vitalsHandler),
            });
            const reportTiming = createTimingReporter({
                path: () => '/checkout/:step',
                context: () => ({ appVersion: '5.12.0', env }),
                transport: sendTo(timingsHandler),
            });

            reportVital({ name: 'LCP', value: 1850, rating: 'good' });
            reportTiming('bridge_init', 42.5);

            const responses = await Promise.all(pending);

            assert.deepEqual(
                responses.map((r) => r.status),
                [204, 204],
            );
            assert.deepEqual(vitals, [
                {
                    name: 'LCP',
                    value: 1850,
                    rating: 'good',
                    path: '/checkout/:step',
                    context: { appVersion: '5.12.0', env: 'android-webview' },
                },
            ]);
            assert.deepEqual(timings, [
                {
                    name: 'bridge_init',
                    duration: 42.5,
                    path: '/checkout/:step',
                    context: { appVersion: '5.12.0', env: 'android-webview' },
                },
            ]);
        });
    });
});
