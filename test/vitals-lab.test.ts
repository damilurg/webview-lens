import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLLECTOR, formatMetric, median, toMarkdown } from '../src/node/vitals-lab.ts';
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
