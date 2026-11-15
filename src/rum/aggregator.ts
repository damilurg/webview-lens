// Edge-safe, zero-dependency RUM aggregator (bounded ring buffer) and Prometheus text exporter.

import type { MetricName } from '../shared/thresholds.ts';
import type { ClientLogEntry, TimingMetric, VitalMetric } from './server.ts';

export interface RumAggregatorOptions {
    /** Maximum samples retained per (name, path, env) series for quantile estimation. Default: 1000. */
    maxSamplesPerSeries?: number;
    /** Maximum distinct series per metric family to guard against cardinality explosions. Default: 200. */
    maxSeries?: number;
}

export interface VitalSummary {
    name: MetricName;
    path: string;
    env: string;
    count: number;
    goodRate: number;
    p50: number;
    p75: number;
    p95: number;
}

export interface TimingSummary {
    name: string;
    path: string;
    env: string;
    count: number;
    p50: number;
    p75: number;
    p95: number;
}

export interface ErrorCounter {
    path: string;
    env: string;
    count: number;
}

export interface RumSnapshot {
    vitals: VitalSummary[];
    timings: TimingSummary[];
    errors: ErrorCounter[];
}

export interface RumAggregator {
    recordVital(metric: VitalMetric): void;
    recordTiming(timing: TimingMetric): void;
    recordError(entry: Pick<ClientLogEntry, 'fields'>): void;
    snapshot(): RumSnapshot;
    reset(): void;
}

interface SeriesBuffer<K> {
    meta: K;
    count: number;
    goodCount: number;
    samples: number[];
    cursor: number;
}

const pushSample = <K>(series: SeriesBuffer<K>, value: number, limit: number): void => {
    series.count += 1;
    if (series.samples.length < limit) {
        series.samples.push(value);

        return;
    }
    series.samples[series.cursor] = value;
    series.cursor = (series.cursor + 1) % limit;
};

const quantile = (sorted: readonly number[], q: number): number => {
    if (sorted.length === 0) return 0;

    const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);

    return sorted[Math.max(0, index)] ?? 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const extractEnv = (context?: Record<string, string>): string => context?.env ?? 'unknown';

const extractErrorLabels = (fields: Record<string, unknown>): { path: string; env: string } => {
    const path = typeof fields.path === 'string' && fields.path ? fields.path : '/';
    const ctx = isRecord(fields.context) ? fields.context : undefined;
    const env = typeof ctx?.env === 'string' && ctx.env ? ctx.env : 'unknown';

    return { path, env };
};

/** Creates a bounded in-memory RUM aggregator with p50/p75/p95 and goodRate calculations. */
export const createRumAggregator = ({
    maxSamplesPerSeries = 1000,
    maxSeries = 200,
}: RumAggregatorOptions = {}): RumAggregator => {
    const vitals = new Map<string, SeriesBuffer<{ name: MetricName; path: string; env: string }>>();
    const timings = new Map<string, SeriesBuffer<{ name: string; path: string; env: string }>>();
    const errors = new Map<string, ErrorCounter>();

    const recordVital = (metric: VitalMetric): void => {
        const env = extractEnv(metric.context);
        const key = `${metric.name}\0${metric.path}\0${env}`;
        let series = vitals.get(key);

        if (!series) {
            if (vitals.size >= maxSeries) return;
            series = {
                meta: { name: metric.name, path: metric.path, env },
                count: 0,
                goodCount: 0,
                samples: [],
                cursor: 0,
            };
            vitals.set(key, series);
        }

        pushSample(series, metric.value, maxSamplesPerSeries);
        if (metric.rating === 'good') series.goodCount += 1;
    };

    const recordTiming = (timing: TimingMetric): void => {
        const env = extractEnv(timing.context);
        const key = `${timing.name}\0${timing.path}\0${env}`;
        let series = timings.get(key);

        if (!series) {
            if (timings.size >= maxSeries) return;
            series = {
                meta: { name: timing.name, path: timing.path, env },
                count: 0,
                goodCount: 0,
                samples: [],
                cursor: 0,
            };
            timings.set(key, series);
        }

        pushSample(series, timing.duration, maxSamplesPerSeries);
    };

    const recordError = (entry: Pick<ClientLogEntry, 'fields'>): void => {
        const { path, env } = extractErrorLabels(entry.fields);
        const key = `${path}\0${env}`;
        const existing = errors.get(key);

        if (existing) {
            existing.count += 1;

            return;
        }
        if (errors.size >= maxSeries) return;
        errors.set(key, { path, env, count: 1 });
    };

    const snapshot = (): RumSnapshot => ({
        vitals: [...vitals.values()].map((s) => {
            const sorted = [...s.samples].sort((a, b) => a - b);

            return {
                ...s.meta,
                count: s.count,
                goodRate: s.count > 0 ? Math.round((s.goodCount / s.count) * 1000) / 1000 : 0,
                p50: quantile(sorted, 0.5),
                p75: quantile(sorted, 0.75),
                p95: quantile(sorted, 0.95),
            };
        }),
        timings: [...timings.values()].map((s) => {
            const sorted = [...s.samples].sort((a, b) => a - b);

            return {
                ...s.meta,
                count: s.count,
                p50: quantile(sorted, 0.5),
                p75: quantile(sorted, 0.75),
                p95: quantile(sorted, 0.95),
            };
        }),
        errors: [...errors.values()].map((e) => ({ ...e })),
    });

    const reset = (): void => {
        vitals.clear();
        timings.clear();
        errors.clear();
    };

    return { recordVital, recordTiming, recordError, snapshot, reset };
};

/** Escapes a Prometheus label value per the exposition text format spec. */
export const escapePromLabel = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const formatLabels = (labels: Record<string, string>): string =>
    `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${escapePromLabel(v)}"`)
        .join(',')}}`;

/** Renders a `RumSnapshot` into Prometheus exposition format (`version=0.0.4`). */
export const toPrometheusText = (snapshot: RumSnapshot, prefix = 'webview_lens'): string => {
    const lines: string[] = [];

    if (snapshot.vitals.length > 0) {
        lines.push(`# HELP ${prefix}_vital_count Total Web Vital samples received`);
        lines.push(`# TYPE ${prefix}_vital_count counter`);
        for (const v of snapshot.vitals) {
            lines.push(
                `${prefix}_vital_count${formatLabels({ name: v.name, path: v.path, env: v.env })} ${v.count}`,
            );
        }

        lines.push(`# HELP ${prefix}_vital_good_rate Share of good Web Vitals (0..1)`);
        lines.push(`# TYPE ${prefix}_vital_good_rate gauge`);
        for (const v of snapshot.vitals) {
            lines.push(
                `${prefix}_vital_good_rate${formatLabels({ name: v.name, path: v.path, env: v.env })} ${v.goodRate}`,
            );
        }

        lines.push(`# HELP ${prefix}_vital_quantile Web Vital quantile value`);
        lines.push(`# TYPE ${prefix}_vital_quantile gauge`);
        for (const v of snapshot.vitals) {
            for (const [q, val] of [
                ['0.5', v.p50],
                ['0.75', v.p75],
                ['0.95', v.p95],
            ] as const) {
                lines.push(
                    `${prefix}_vital_quantile${formatLabels({ name: v.name, path: v.path, env: v.env, quantile: q })} ${val}`,
                );
            }
        }
    }

    if (snapshot.timings.length > 0) {
        lines.push(`# HELP ${prefix}_timing_quantile Custom timing quantile in milliseconds`);
        lines.push(`# TYPE ${prefix}_timing_quantile gauge`);
        for (const t of snapshot.timings) {
            for (const [q, val] of [
                ['0.5', t.p50],
                ['0.75', t.p75],
                ['0.95', t.p95],
            ] as const) {
                lines.push(
                    `${prefix}_timing_quantile${formatLabels({ name: t.name, path: t.path, env: t.env, quantile: q })} ${val}`,
                );
            }
        }
    }

    if (snapshot.errors.length > 0) {
        lines.push(`# HELP ${prefix}_client_errors_total Total client errors received`);
        lines.push(`# TYPE ${prefix}_client_errors_total counter`);
        for (const e of snapshot.errors) {
            lines.push(
                `${prefix}_client_errors_total${formatLabels({ path: e.path, env: e.env })} ${e.count}`,
            );
        }
    }

    if (lines.length === 0) return '';

    return `${lines.join('\n')}\n`;
};

export interface MetricsHandlerOptions {
    prefix?: string;
}

/** Fetch API handler for `GET /metrics` exposing aggregated RUM stats to Prometheus. */
export const createMetricsHandler =
    (aggregator: RumAggregator, { prefix = 'webview_lens' }: MetricsHandlerOptions = {}) =>
    async (request: Request): Promise<Response> => {
        if (request.method !== 'GET') {
            return new Response(null, { status: 405, headers: { allow: 'GET' } });
        }

        return new Response(toPrometheusText(aggregator.snapshot(), prefix), {
            status: 200,
            headers: {
                'content-type': 'text/plain; version=0.0.4; charset=utf-8',
                'cache-control': 'no-store',
            },
        });
    };
