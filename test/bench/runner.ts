// Zero-dependency micro-benchmark runner (Vitest `bench` analog) using nanosecond hrtime.

export interface BenchOptions {
    /** Warmup iterations excluded from stats. Default: 50. */
    warmup?: number;
    /** Minimum measured iterations. Default: 200. */
    iterations?: number;
    /** Minimum measurement duration in milliseconds. Default: 100. */
    minTimeMs?: number;
}

export interface BenchResult {
    name: string;
    iterations: number;
    opsPerSec: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    p75Ms: number;
    p99Ms: number;
    /** Relative margin of error (%) at 95% confidence. */
    rme: number;
}

export interface BenchBudgetViolation {
    name: string;
    meanMs: number;
    maxMeanMs: number;
}

const NS_PER_MS = 1_000_000;

const percentile = (sorted: readonly number[], p: number): number => {
    if (sorted.length === 0) return 0;

    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);

    return sorted[Math.max(0, index)] ?? 0;
};

/** Computes benchmark statistics from raw nanosecond samples. */
export const computeStats = (name: string, samplesNs: readonly number[]): BenchResult => {
    if (samplesNs.length === 0) {
        return {
            name,
            iterations: 0,
            opsPerSec: 0,
            meanMs: 0,
            minMs: 0,
            maxMs: 0,
            p75Ms: 0,
            p99Ms: 0,
            rme: 0,
        };
    }

    const sortedMs = samplesNs.map((ns) => ns / NS_PER_MS).sort((a, b) => a - b);
    const n = sortedMs.length;
    const sum = sortedMs.reduce((acc, x) => acc + x, 0);
    const meanMs = sum / n;
    const variance = n > 1 ? sortedMs.reduce((acc, x) => acc + (x - meanMs) ** 2, 0) / (n - 1) : 0;
    const sem = Math.sqrt(variance / n);
    const rme = meanMs > 0 ? ((1.96 * sem) / meanMs) * 100 : 0;

    return {
        name,
        iterations: n,
        opsPerSec: meanMs > 0 ? 1000 / meanMs : Infinity,
        meanMs,
        minMs: sortedMs[0] ?? 0,
        maxMs: sortedMs[n - 1] ?? 0,
        p75Ms: percentile(sortedMs, 75),
        p99Ms: percentile(sortedMs, 99),
        rme,
    };
};

/** Runs a synchronous benchmark function with warmup and minimum iterations/time. */
export const runBench = (
    name: string,
    fn: () => void,
    { warmup = 50, iterations = 200, minTimeMs = 100 }: BenchOptions = {},
): BenchResult => {
    for (let i = 0; i < warmup; i += 1) fn();

    const samplesNs: number[] = [];
    const minTotalNs = BigInt(Math.round(minTimeMs * NS_PER_MS));
    const startedAt = process.hrtime.bigint();

    while (
        samplesNs.length < iterations ||
        (minTimeMs > 0 && process.hrtime.bigint() - startedAt < minTotalNs)
    ) {
        const t0 = process.hrtime.bigint();

        fn();
        samplesNs.push(Number(process.hrtime.bigint() - t0));
    }

    return computeStats(name, samplesNs);
};

const formatDuration = (ms: number): string => {
    if (ms < 0.001) return `${(ms * 1_000_000).toFixed(0)} ns`;
    if (ms < 1) return `${(ms * 1000).toFixed(2)} µs`;

    return `${ms.toFixed(3)} ms`;
};

const formatOps = (ops: number): string => {
    if (!Number.isFinite(ops)) return '∞';
    if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`;
    if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)}k`;

    return ops.toFixed(1);
};

/** Formats benchmark results into a Markdown-style summary table. */
export const formatBenchTable = (results: readonly BenchResult[]): string => {
    const header = '| Benchmark | ops/sec | mean | p75 | p99 | rme | samples |';
    const sep = '| --- | ---: | ---: | ---: | ---: | ---: | ---: |';
    const rows = results.map(
        (r) =>
            `| ${r.name} | ${formatOps(r.opsPerSec)} | ${formatDuration(r.meanMs)} | ${formatDuration(r.p75Ms)} | ${formatDuration(r.p99Ms)} | ±${r.rme.toFixed(2)}% | ${r.iterations} |`,
    );

    return [header, sep, ...rows].join('\n');
};

/** Checks benchmark mean latencies against regression budgets (in milliseconds). */
export const checkBenchBudgets = (
    results: readonly BenchResult[],
    budgetsMs: Readonly<Record<string, number>>,
): BenchBudgetViolation[] => {
    const violations: BenchBudgetViolation[] = [];

    for (const result of results) {
        const maxMeanMs = budgetsMs[result.name];

        if (maxMeanMs === undefined) continue;
        if (result.meanMs <= maxMeanMs) continue;

        violations.push({ name: result.name, meanMs: result.meanMs, maxMeanMs });
    }

    return violations;
};
