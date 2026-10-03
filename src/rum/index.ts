// Browser side of RUM: Web Vitals and uncaught errors from real users, sent to your own endpoint.
//
// No dependency on a metrics library: feed it from `web-vitals` (onLCP(report)), Next.js
// (useReportWebVitals(report)) or anything else that yields { name, value, rating? }.
// Delivery uses sendBeacon, which survives the WebView being closed: CLS and INP are final only then.

import {
    isMetricName,
    isRating,
    MAX_PATH_LENGTH,
    type MetricName,
    rate,
    type Rating,
} from '../shared/thresholds.ts';

export {
    METRIC_NAMES,
    type MetricName,
    rate,
    type Rating,
    THRESHOLDS,
} from '../shared/thresholds.ts';

/** What `web-vitals` and Next.js `useReportWebVitals` hand to their callbacks. */
export interface MetricLike {
    name: string;
    value: number;
    rating?: string;
    navigationType?: string;
}

/** The body the reporter sends and `createVitalsHandler` accepts. */
export interface VitalPayload {
    name: MetricName;
    value: number;
    rating: Rating;
    path: string;
    navigationType?: string;
}

/** Sends a JSON body to an endpoint without waiting for the answer. */
export type Transport = (endpoint: string, body: string) => void;

/**
 * sendBeacon, or `fetch` with keepalive where the beacon is unavailable or refused.
 * Use a same-origin endpoint: a cross-origin JSON beacon needs a CORS preflight.
 */
export const beaconTransport: Transport = (endpoint, body) => {
    const isQueued =
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));

    if (isQueued) return;

    fetch(endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'content-type': 'application/json' },
    }).catch(() => undefined);
};

/**
 * Page path safe to report: no query or hash (they carry search terms and other user data),
 * only route characters, bounded length.
 */
export const sanitizePath = (pathname: string): string => {
    const bare = pathname.split(/[?#]/)[0] ?? '';
    const safe = bare.replace(/[^\w\-./[\]]/g, '_').slice(0, MAX_PATH_LENGTH);

    return safe.startsWith('/') ? safe : `/${safe}`.slice(0, MAX_PATH_LENGTH);
};

const currentPath = (): string =>
    typeof location === 'undefined' ? '/' : sanitizePath(location.pathname);

export interface VitalsReporterOptions {
    /** Default `/api/vitals`. */
    endpoint?: string;
    /**
     * Path to report. Default: `location.pathname`. Return a route template (`/event/[id]`)
     * to group pages and keep ids out of the data.
     */
    path?: () => string;
    /** Share of page loads that report, 0..1, decided once per load. Default 1. */
    sampleRate?: number;
    /** Also print each metric to the console: visible in the WebView DevTools right away. */
    debug?: boolean;
    transport?: Transport;
}

/**
 * A callback for metric sources. Create it once (module scope): Next.js re-subscribes when the
 * callback identity changes.
 */
export const createVitalsReporter = ({
    endpoint = '/api/vitals',
    path = currentPath,
    sampleRate = 1,
    debug = false,
    transport = beaconTransport,
}: VitalsReporterOptions = {}): ((metric: MetricLike) => void) => {
    const isSampled = Math.random() < sampleRate;

    return (metric) => {
        // Next.js also reports its own metrics (Next.js-hydration and so on).
        if (!isMetricName(metric.name) || !Number.isFinite(metric.value) || metric.value < 0) {
            return;
        }

        const payload: VitalPayload = {
            name: metric.name,
            value: metric.value,
            rating: isRating(metric.rating) ? metric.rating : rate(metric.name, metric.value),
            path: sanitizePath(path()),
        };

        if (metric.navigationType) payload.navigationType = metric.navigationType.slice(0, 40);

        if (debug) {
            console.info(
                `[webview-lens] ${payload.name} ${payload.rating}`,
                Math.round(payload.value * 1000) / 1000,
            );
        }

        if (isSampled) transport(endpoint, JSON.stringify(payload));
    };
};

export interface ErrorReporterOptions {
    /** Default `/api/client-log`. */
    endpoint?: string;
    path?: () => string;
    /** Reports per page load; a render loop must not flood the log. Default 10. */
    maxReports?: number;
    transport?: Transport;
}

/** Sends `{ message, ...fields }` to the client log endpoint; `createClientLogHandler` reads it. */
export const createErrorReporter = ({
    endpoint = '/api/client-log',
    path = currentPath,
    maxReports = 10,
    transport = beaconTransport,
}: ErrorReporterOptions = {}): ((report: Record<string, unknown>) => void) => {
    let sent = 0;
    const seen = new Set<string>();

    return (report) => {
        const key = `${String(report.source)}|${String(report.message)}`;

        if (sent >= maxReports || seen.has(key)) return;
        sent += 1;
        seen.add(key);
        transport(endpoint, JSON.stringify({ path: sanitizePath(path()), ...report }));
    };
};

const describe = (reason: unknown): { message: string; stack?: string } => {
    if (reason instanceof Error) {
        return reason.stack
            ? { message: reason.message, stack: reason.stack }
            : { message: reason.message };
    }

    return { message: String(reason) };
};

/**
 * Reports uncaught errors and unhandled promise rejections. Returns a function that stops it.
 */
export const captureGlobalErrors = (
    report: (fields: Record<string, unknown>) => void,
    target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): (() => void) => {
    const onError = (event: ErrorEvent) => {
        report({
            source: 'window.error',
            ...describe(event.error ?? event.message),
            file: event.filename,
            line: event.lineno,
            column: event.colno,
        });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
        report({ source: 'unhandledrejection', ...describe(event.reason) });
    };

    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);

    return () => {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
    };
};
