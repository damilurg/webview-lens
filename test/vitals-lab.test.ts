import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    checkBudgets,
    COLLECTOR,
    formatMetric,
    median,
    parseBudgets,
    toMarkdown,
    measureVitals,
} from '../src/node/vitals-lab.ts';
import { rate } from '../src/shared/thresholds.ts';

describe('median', () => {
    it('odd and even counts, nulls skipped', () => {
        assert.equal(median([3, null, 1, 2]), 2);
        assert.equal(median([4, 1, 3, 2]), 2.5);
    });

    it('no values: null', () => {
        assert.equal(median([null, undefined]), null);
    });
});

describe('rate', () => {
    it('boundaries belong to the better rating', () => {
        assert.equal(rate('LCP', 2500), 'good');
        assert.equal(rate('LCP', 4000), 'needs-improvement');
        assert.equal(rate('LCP', 4001), 'poor');
    });
});

describe('report', () => {
    it('formats CLS unitless and the rest in ms', () => {
        assert.equal(formatMetric('CLS', 0.12345), '0.123');
        assert.equal(formatMetric('LCP', 1234.6), '1235 ms');
        assert.equal(formatMetric('INP', null), '—');
    });

    it('markdown has a rated row per screen', () => {
        const markdown = toMarkdown(
            {
                origin: 'https://stand.example.test',
                device: 'Android WebView',
                options: { runs: 3, cold: true, interact: 0 },
                rows: [
                    {
                        path: '/',
                        LCP: 1200,
                        FCP: 900,
                        CLS: 0.3,
                        INP: null,
                        TTFB: 300,
                        lcpElement: 'img',
                        shifts: [0.3],
                    },
                ],
            },
            new Date('2026-01-01T00:00:00Z'),
        );

        assert.match(
            markdown,
            /\| `\/` \| 🟢 1200 ms \| 🟢 900 ms \| 🔴 0\.300 \| ⚪ — \| 🟢 300 ms \| img \| 0\.3 \|/,
        );
        assert.match(markdown, /cache: disabled/);
    });

    it('the in-page collector is valid JavaScript', () => {
        assert.doesNotThrow(() => new Function(COLLECTOR));
    });
});

describe('budgets', () => {
    it('parses valid budget specs and rejects unknown metrics or negative values', () => {
        assert.deepEqual(parseBudgets('lcp=2500, cls=0.1 , TTFB=800'), {
            LCP: 2500,
            CLS: 0.1,
            TTFB: 800,
        });
        assert.throws(() => parseBudgets('unknown=100'), /Unknown budget metric/);
        assert.throws(() => parseBudgets('lcp=-10'), /Invalid budget value/);
    });

    it('returns empty array when all measured metrics are within limits', () => {
        const violations = checkBudgets(
            {
                origin: 'https://stand.example.test',
                device: 'Android',
                options: { runs: 1, cold: false, interact: 0 },
                rows: [
                    {
                        path: '/',
                        LCP: 1500,
                        FCP: 800,
                        CLS: 0.02,
                        INP: null,
                        TTFB: 200,
                        lcpElement: null,
                        shifts: [],
                    },
                ],
            },
            { LCP: 2500, CLS: 0.1 },
        );

        assert.deepEqual(violations, []);
    });
});

describe('lab vitals on iOS (found on iOS 26.6)', () => {
    it('keeps CLS n/a (null) where layout-shift entries do not exist', () => {
        assert.match(COLLECTOR, /cls: clsSupported \? 0 : null/);
    });

    it('does not hand the Android forward port to the iOS driver', async () => {
        let seenPort: unknown = 'not called';
        const target = {
            id: 'p1',
            platform: 'ios' as const,
            type: 'page',
            url: 'https://stand.test/',
            title: '',
            debuggerUrl: 'ws://x',
        };
        const driver = {
            platform: 'ios' as const,
            listDevices: () => [],
            isAvailable: () => true,
            diagnose: async () => '',
            doctor: async () => ({ platform: 'ios' as const, checks: [], targets: [] }),
            listTargets: async () => [target],
            getDeviceDescription: async () => 'iPhone',
            waitForTarget: async (_predicate: unknown, options: { port?: unknown } = {}) => {
                seenPort = options.port;

                return target;
            },
            connectInspector: async () => {
                let resolveClosed!: () => void;

                return {
                    platform: 'ios' as const,
                    capabilities: { lcp: true, cls: false, inp: false, cdpFetchOverride: false },
                    evaluate: async <T>() =>
                        JSON.stringify({ lcp: 80, fcp: 30, cls: null, inp: null, ttfb: 20 }) as T,
                    addInitScript: async () => undefined,
                    navigate: async () => undefined,
                    reload: async () => undefined,
                    setCacheDisabled: async () => undefined,
                    close: () => resolveClosed(),
                    closed: new Promise<void>((resolve) => {
                        resolveClosed = resolve;
                    }),
                };
            },
        };

        await measureVitals({ driver, paths: ['/'], runs: 1, settleMs: 0, log: () => undefined });
        assert.equal(seenPort, undefined);
    });
});
