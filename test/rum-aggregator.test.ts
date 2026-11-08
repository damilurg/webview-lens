import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createMetricsHandler,
    createRumAggregator,
    escapePromLabel,
    toPrometheusText,
} from '../src/rum/server.ts';

describe('createRumAggregator ring buffer & Prometheus escaping', () => {
    it('bounds memory with ring buffer while keeping accurate total count', () => {
        const agg = createRumAggregator({ maxSamplesPerSeries: 3, maxSeries: 2 });

        for (const value of [100, 200, 300, 400, 500]) {
            agg.recordVital({ name: 'TTFB', value, rating: 'good', path: '/' });
        }

        const snap = agg.snapshot();

        assert.equal(snap.vitals[0]?.count, 5);
        // Ring buffer retains last 3 values: [300, 400, 500]
        assert.equal(snap.vitals[0]?.p50, 400);
        assert.equal(snap.vitals[0]?.p95, 500);
    });

    it('caps total cardinality by maxSeries and supports reset()', () => {
        const agg = createRumAggregator({ maxSeries: 1 });

        agg.recordVital({ name: 'FCP', value: 500, rating: 'good', path: '/a' });
        agg.recordVital({ name: 'FCP', value: 600, rating: 'good', path: '/b' });

        assert.equal(agg.snapshot().vitals.length, 1);

        agg.reset();
        assert.equal(agg.snapshot().vitals.length, 0);
    });

    it('escapes Prometheus label values and rejects non-GET on createMetricsHandler', async () => {
        assert.equal(escapePromLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');

        const agg = createRumAggregator();
        const handler = createMetricsHandler(agg);
        const postRes = await handler(
            new Request('https://app.example.test/metrics', { method: 'POST' }),
        );

        assert.equal(postRes.status, 405);
        assert.equal(toPrometheusText(agg.snapshot()), '');
    });
});
