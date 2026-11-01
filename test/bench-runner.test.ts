import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkBenchBudgets, computeStats, formatBenchTable, runBench } from './bench/runner.ts';

describe('benchmark runner (vitest bench analog)', () => {
    it('computes mean, min, max, p75, p99, ops/sec and rme from nanosecond samples', () => {
        // 10 samples from 1ms to 10ms in nanoseconds
        const samples = Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000_000);
        const stats = computeStats('sample', samples);

        assert.equal(stats.name, 'sample');
        assert.equal(stats.iterations, 10);
        assert.equal(stats.minMs, 1);
        assert.equal(stats.maxMs, 10);
        assert.equal(stats.meanMs, 5.5);
        assert.equal(stats.p75Ms, 8);
        assert.equal(stats.p99Ms, 10);
        assert.ok(stats.opsPerSec > 180 && stats.opsPerSec < 183);
        assert.ok(stats.rme >= 0);
    });

    it('runs warmup + measured iterations and formats a readable table', () => {
        let count = 0;
        const result = runBench(
            'increment',
            () => {
                count += 1;
            },
            { warmup: 5, iterations: 20, minTimeMs: 0 },
        );

        assert.equal(result.iterations, 20);
        assert.equal(count, 25);
        assert.ok(result.opsPerSec > 0);

        const table = formatBenchTable([result]);

        assert.match(table, /increment/);
        assert.match(table, /ops\/sec/);
        assert.match(table, /p99/);
    });

    it('detects benchmark budget regressions via checkBenchBudgets', () => {
        const fast = computeStats('fast', [100_000, 100_000]); // 0.1 ms
        const slow = computeStats('slow', [5_000_000, 5_000_000]); // 5 ms

        const violations = checkBenchBudgets([fast, slow], { fast: 1, slow: 2 });

        assert.deepEqual(violations, [{ name: 'slow', meanMs: 5, maxMeanMs: 2 }]);
    });
});
