import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    captureGlobalErrors,
    createErrorReporter,
    createVitalsReporter,
    sanitizePath,
} from '../src/rum/index.ts';
import { parseVital } from '../src/rum/server.ts';

const spyTransport = () => {
    const sent: { endpoint: string; body: unknown }[] = [];

    return {
        sent,
        transport: (endpoint: string, body: string) =>
            sent.push({ endpoint, body: JSON.parse(body) }),
    };
};

describe('sanitizePath', () => {
    it('drops query and hash', () => {
        assert.equal(sanitizePath('/search?q=secret#top'), '/search');
    });

    it('replaces foreign characters and keeps route templates', () => {
        assert.equal(sanitizePath('/event/[id]/a b<script>'), '/event/[id]/a_b_script_');
    });

    it('bounds the length and keeps the leading slash', () => {
        assert.equal(sanitizePath('x'.repeat(500)).length, 200);
        assert.ok(sanitizePath('relative').startsWith('/'));
    });

    it('its output passes the server check', () => {
        const metric = { name: 'LCP', value: 1, rating: 'good', path: sanitizePath('/a b?c=d') };

        assert.ok(parseVital(metric));
    });
});

describe('createVitalsReporter', () => {
    it('sends a Web Vital with the given path', () => {
        const spy = spyTransport();
        const report = createVitalsReporter({
            transport: spy.transport,
            path: () => '/event/[id]',
        });

        report({ name: 'LCP', value: 1234.5, rating: 'good', navigationType: 'navigate' });

        assert.deepEqual(spy.sent, [
            {
                endpoint: '/api/vitals',
                body: {
                    name: 'LCP',
                    value: 1234.5,
                    rating: 'good',
                    path: '/event/[id]',
                    navigationType: 'navigate',
                },
            },
        ]);
    });

    it('computes the rating when the source gives none', () => {
        const spy = spyTransport();

        createVitalsReporter({ transport: spy.transport, path: () => '/' })({
            name: 'CLS',
            value: 0.3,
        });

        assert.equal((spy.sent[0]?.body as { rating: string }).rating, 'poor');
    });

    it('ignores framework metrics and broken values', () => {
        const spy = spyTransport();
        const report = createVitalsReporter({ transport: spy.transport, path: () => '/' });

        report({ name: 'Next.js-hydration', value: 10 });
        report({ name: 'LCP', value: Number.NaN });
        report({ name: 'INP', value: -1 });

        assert.equal(spy.sent.length, 0);
    });

    it('sample rate 0 sends nothing', () => {
        const spy = spyTransport();

        createVitalsReporter({ transport: spy.transport, path: () => '/', sampleRate: 0 })({
            name: 'LCP',
            value: 1,
        });

        assert.equal(spy.sent.length, 0);
    });
});

describe('createErrorReporter', () => {
    it('sends each distinct error once, up to the limit', () => {
        const spy = spyTransport();
        const report = createErrorReporter({
            transport: spy.transport,
            path: () => '/p',
            maxReports: 2,
        });

        report({ source: 'a', message: 'one' });
        report({ source: 'a', message: 'one' });
        report({ source: 'a', message: 'two' });
        report({ source: 'a', message: 'three' });

        assert.deepEqual(
            spy.sent.map((s) => s.body),
            [
                { path: '/p', source: 'a', message: 'one' },
                { path: '/p', source: 'a', message: 'two' },
            ],
        );
    });
});

describe('captureGlobalErrors', () => {
    it('reports uncaught errors and rejections until stopped', () => {
        const target = new EventTarget();
        const reports: Record<string, unknown>[] = [];
        const stop = captureGlobalErrors((fields) => reports.push(fields), target);
        const error = Object.assign(new Event('error'), {
            error: new Error('boom'),
            filename: 'app.js',
            lineno: 1,
            colno: 2,
        });

        target.dispatchEvent(error);
        target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'nope' }));
        stop();
        target.dispatchEvent(
            Object.assign(new Event('unhandledrejection'), { reason: 'after stop' }),
        );

        assert.equal(reports.length, 2);
        assert.equal(reports[0]?.message, 'boom');
        assert.equal(reports[0]?.file, 'app.js');
        assert.deepEqual(reports[1], { source: 'unhandledrejection', message: 'nope' });
    });
});
