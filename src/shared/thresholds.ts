/** Core Web Vitals and the two loading metrics that explain them. */
export type MetricName = 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB';

export type Rating = 'good' | 'needs-improvement' | 'poor';

export const METRIC_NAMES: readonly MetricName[] = ['LCP', 'FCP', 'CLS', 'INP', 'TTFB'];

export const RATINGS: readonly Rating[] = ['good', 'needs-improvement', 'poor'];

/**
 * web.dev thresholds: a value up to the first number is good, above the second is poor.
 * CLS is unitless, the rest are milliseconds.
 */
export const THRESHOLDS: Readonly<Record<MetricName, readonly [good: number, poor: number]>> = {
    LCP: [2500, 4000],
    FCP: [1800, 3000],
    CLS: [0.1, 0.25],
    INP: [200, 500],
    TTFB: [800, 1800],
};

export const isMetricName = (value: unknown): value is MetricName =>
    typeof value === 'string' && (METRIC_NAMES as readonly string[]).includes(value);

export const isRating = (value: unknown): value is Rating =>
    typeof value === 'string' && (RATINGS as readonly string[]).includes(value);

export const rate = (name: MetricName, value: number): Rating => {
    const [good, poor] = THRESHOLDS[name];

    if (value <= good) return 'good';
    if (value <= poor) return 'needs-improvement';

    return 'poor';
};

/** Characters a reported page path may contain: route segments, Next `[param]` and router `:param` templates. */
export const PATH_PATTERN = /^\/[\w\-./[\]:]*$/;

export const MAX_PATH_LENGTH = 200;
