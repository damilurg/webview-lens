import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
} from '../../src/rum/server.ts';

describe('Feature: Production RUM aggregator (p50/p75/p95) and Prometheus /metrics endpoint', () => {
    describe('Scenario: Recording Web Vitals, custom timings and client errors and scraping /metrics', () => {
        it('Given RUM handlers wired to createRumAggregator, When real metrics arrive, Then snapshot computes p50/p75/p95/goodRate and GET /metrics serves valid Prometheus text', async () => {
            const aggregator = createRumAggregator();
            const postVital = createVitalsHandler({ onMetric: (m) => aggregator.recordVital(m) });
            const postTiming = createTimingsHandler({
                onTiming: (t) => aggregator.recordTiming(t),
            });
            const postError = createClientLogHandler({ onLog: (e) => aggregator.recordError(e) });
            const getMetrics = createMetricsHandler(aggregator);

            const send = (
                handler: (r: Request) => Promise<Response>,
                payload: Record<string, unknown>,
            ) =>
                handler(
                    new Request('https://app.example.test/api/rum', {
                        method: 'POST',
                        body: JSON.stringify(payload),
                        headers: { 'content-type': 'application/json' },
                    }),
                );

            for (const [value, rating] of [
                [1000, 'good'],
                [1500, 'good'],
                [2000, 'good'],
                [4500, 'poor'],
            ] as const) {
                const res = await send(postVital, {
                    name: 'LCP',
                    value,
                    rating,
                    path: '/checkout/:id',
                    context: { env: 'android-webview' },
                });

                assert.equal(res.status, 204);
            }

            await send(postTiming, {
                name: 'bridge_init',
                duration: 40,
                path: '/checkout/:id',
                context: { env: 'ios-wkwebview' },
            });
            await send(postError, {
                message: 'bridge timeout',
                path: '/checkout/:id',
                context: { env: 'ios-wkwebview' },
            });

            const snap = aggregator.snapshot();

            assert.equal(snap.vitals.length, 1);
            assert.equal(snap.vitals[0]?.count, 4);
            assert.equal(snap.vitals[0]?.p50, 1500);
            assert.equal(snap.vitals[0]?.p75, 2000);
            assert.equal(snap.vitals[0]?.p95, 4500);
            assert.equal(snap.vitals[0]?.goodRate, 0.75);
            assert.equal(snap.timings[0]?.name, 'bridge_init');
            assert.equal(snap.errors[0]?.count, 1);

            const metricsRes = await getMetrics(new Request('https://app.example.test/metrics'));

            assert.equal(metricsRes.status, 200);
            assert.match(
                metricsRes.headers.get('content-type') ?? '',
                /text\/plain;\s*version=0\.0\.4/,
            );

            const text = await metricsRes.text();

            assert.match(
                text,
                /webview_lens_vital_quantile\{name="LCP",path="\/checkout\/:id",env="android-webview",quantile="0\.75"\} 2000/,
            );
            assert.match(
                text,
                /webview_lens_vital_good_rate\{name="LCP",path="\/checkout\/:id",env="android-webview"\} 0\.75/,
            );
            assert.match(
                text,
                /webview_lens_timing_quantile\{name="bridge_init",path="\/checkout\/:id",env="ios-wkwebview",quantile="0\.5"\} 40/,
            );
            assert.match(
                text,
                /webview_lens_client_errors_total\{path="\/checkout\/:id",env="ios-wkwebview"\} 1/,
            );
        });
    });
});
