import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    type ClientLogEntry,
    createClientLogHandler,
    createVitalsHandler,
    readLimitedText,
    type VitalMetric,
} from '../src/rum/server.ts';

const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://app.example.test/api/x', { method: 'POST', body, headers });

describe('createVitalsHandler', () => {
    const setup = () => {
        const metrics: VitalMetric[] = [];
        const rejects: string[] = [];
        const handler = createVitalsHandler({
            onMetric: (metric) => void metrics.push(metric),
            onReject: (reason) => void rejects.push(reason),
        });

        return { metrics, rejects, handler };
    };

    it('valid metric: 204 and the checked fields only', async () => {
        const { metrics, handler } = setup();
        const response = await handler(
            post(
                JSON.stringify({
                    name: 'INP',
                    value: 120,
                    rating: 'good',
                    path: '/events',
                    extra: 'x',
                }),
            ),
        );

        assert.equal(response.status, 204);
        assert.deepEqual(metrics, [{ name: 'INP', value: 120, rating: 'good', path: '/events' }]);
    });

    it('path with a query, unknown metric or non-JSON: 400', async () => {
        const { metrics, rejects, handler } = setup();

        for (const body of [
            JSON.stringify({ name: 'LCP', value: 1, rating: 'good', path: '/search?q=me' }),
            JSON.stringify({ name: 'FID', value: 1, rating: 'good', path: '/' }),
            'not json',
        ]) {
            assert.equal((await handler(post(body))).status, 400);
        }
        assert.equal(metrics.length, 0);
        assert.deepEqual(rejects, ['invalid', 'invalid', 'invalid']);
    });

    it('body over the limit: 413', async () => {
        const { handler } = setup();

        assert.equal((await handler(post('x'.repeat(4096)))).status, 413);
    });

    it('not POST: 405', async () => {
        const { handler } = setup();

        assert.equal(
            (await handler(new Request('https://app.example.test/api/vitals'))).status,
            405,
        );
    });
});

describe('createClientLogHandler', () => {
    it('truncates long values (message too), keeps the message apart, adds request headers', async () => {
        const entries: ClientLogEntry[] = [];
        const handler = createClientLogHandler({
            onLog: (entry) => void entries.push(entry),
            maxValueLength: 5,
        });
        const response = await handler(
            post(JSON.stringify({ message: 'render failed', stack: '1234567890' }), {
                'user-agent': 'WebView',
            }),
        );

        assert.equal(response.status, 204);
        assert.deepEqual(entries, [
            { message: 'rende…', fields: { stack: '12345…' }, userAgent: 'WebView', referer: null },
        ]);
    });

    it('too many fields or not an object: 400', async () => {
        const handler = createClientLogHandler({ onLog: () => undefined, maxFields: 2 });

        assert.equal((await handler(post(JSON.stringify({ a: 1, b: 2, c: 3 })))).status, 400);
        assert.equal((await handler(post('[1,2]'))).status, 400);
    });
});

describe('readLimitedText', () => {
    it('stops at the limit even without Content-Length', async () => {
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024));
            },
        });
        const request = new Request('https://app.example.test/', {
            method: 'POST',
            body: stream,
            // Node's fetch requires half-duplex for a streamed body.
            duplex: 'half',
        } as RequestInit);

        assert.equal(await readLimitedText(request, 4096), null);
    });

    it('returns the text within the limit', async () => {
        assert.equal(await readLimitedText(post('hello'), 10), 'hello');
    });
});
