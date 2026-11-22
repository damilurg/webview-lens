// Browser side of RUM: Web Vitals and uncaught errors from real users, sent to your own endpoint.
//
// No dependency on a metrics library: feed it from `web-vitals` (onLCP(report)), Next.js
// (useReportWebVitals(report)) or anything else that yields { name, value, rating? }.
// Delivery uses sendBeacon, which survives the WebView being closed: CLS and INP are final only then.

import {
    CONTEXT_KEY_PATTERN,
    isMetricName,
    isRating,
    MAX_CONTEXT_KEYS,
    MAX_CONTEXT_VALUE_LENGTH,
    MAX_PATH_LENGTH,
    type MetricName,
    rate,
    type Rating,
    TIMING_NAME_PATTERN,
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

/** Detected runtime container for WebView RUM segmentation. */
export type WebViewEnv = 'android-webview' | 'ios-wkwebview' | 'browser';

/** Classifies whether the page runs inside an Android WebView, iOS WKWebView, or regular browser. */
export const detectWebViewEnv = (
    userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): WebViewEnv => {
    if (/;\s*wv\)|\bVersion\/\d+\.\d+\s+Chrome\//i.test(userAgent)) {
        return 'android-webview';
    }
    if (
        /\b(iPhone|iPad|iPod)\b/i.test(userAgent) &&
        !/\b(Safari|CriOS|FxiOS|EdgiOS|OPiOS)\//i.test(userAgent)
    ) {
        return 'ios-wkwebview';
    }

    return 'browser';
};

export type ContextInput = Record<string, string | number | boolean | null | undefined>;

/** Sanitizes optional RUM context tags (bounded key count, safe key names, bounded string values). */
export const sanitizeContext = (
    input: ContextInput | undefined,
): Record<string, string> | undefined => {
    if (!input) return undefined;

    const out: Record<string, string> = {};
    let count = 0;

    for (const [key, value] of Object.entries(input)) {
        if (count >= MAX_CONTEXT_KEYS) break;
        if (value === undefined || value === null) continue;
        if (!CONTEXT_KEY_PATTERN.test(key)) continue;

        out[key] = String(value).slice(0, MAX_CONTEXT_VALUE_LENGTH);
        count += 1;
    }

    return count > 0 ? out : undefined;
};

/** The body the reporter sends and `createVitalsHandler` accepts. */
export interface VitalPayload {
    name: MetricName;
    value: number;
    rating: Rating;
    path: string;
    navigationType?: string;
    context?: Record<string, string>;
}

/** The body `createTimingReporter` sends and `createTimingsHandler` accepts. */
export interface TimingPayload {
    name: string;
    duration: number;
    path: string;
    context?: Record<string, string>;
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
    const safe = bare.replace(/[^\w\-./[\]:]/g, '_').slice(0, MAX_PATH_LENGTH);

    return safe.startsWith('/') ? safe : `/${safe}`.slice(0, MAX_PATH_LENGTH);
};

const currentPath = (): string =>
    typeof location === 'undefined' ? '/' : sanitizePath(location.pathname);

const buildEnvelope = (
    path: () => string,
    context?: () => ContextInput,
): { path: string; context?: Record<string, string> } => {
    const tags = sanitizeContext(context?.());

    return {
        path: sanitizePath(path()),
        ...(tags ? { context: tags } : {}),
    };
};

interface BaseReporterOptions {
    endpoint?: string;
    /**
     * Path to report. Default: `location.pathname`. Return a route template (`/event/[id]`)
     * to group pages and keep ids out of the data.
     */
    path?: () => string;
    /** Optional context tags attached to every report (appVersion, env, release, etc.). */
    context?: () => ContextInput;
    transport?: Transport;
}

export interface VitalsReporterOptions extends BaseReporterOptions {
    /** Default `/api/vitals`. */
    endpoint?: string;
    /** Share of page loads that report, 0..1, decided once per load. Default 1. */
    sampleRate?: number;
    /** Also print each metric to the console: visible in the WebView DevTools right away. */
    debug?: boolean;
}

/**
 * A callback for metric sources. Create it once (module scope): Next.js re-subscribes when the
 * callback identity changes.
 */
export const createVitalsReporter = ({
    endpoint = '/api/vitals',
    path = currentPath,
    sampleRate = 1,
    context,
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
            ...buildEnvelope(path, context),
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

export interface TimingReporterOptions extends BaseReporterOptions {
    /** Default `/api/timings`. */
    endpoint?: string;
    sampleRate?: number;
}

/** Reports custom app/bridge timings (e.g. `bridge_init`, `hydration`) over sendBeacon. */
export const createTimingReporter = ({
    endpoint = '/api/timings',
    path = currentPath,
    sampleRate = 1,
    context,
    transport = beaconTransport,
}: TimingReporterOptions = {}): ((name: string, durationMs: number) => void) => {
    const isSampled = Math.random() < sampleRate;

    return (name, durationMs) => {
        if (!TIMING_NAME_PATTERN.test(name) || !Number.isFinite(durationMs) || durationMs < 0) {
            return;
        }
        if (!isSampled) return;

        const payload: TimingPayload = {
            name,
            duration: durationMs,
            ...buildEnvelope(path, context),
        };

        transport(endpoint, JSON.stringify(payload));
    };
};

export interface ErrorReporterOptions extends BaseReporterOptions {
    /** Default `/api/client-log`. */
    endpoint?: string;
    /** Reports per page load; a render loop must not flood the log. Default 10. */
    maxReports?: number;
}

/** Sends `{ message, ...fields }` to the client log endpoint; `createClientLogHandler` reads it. */
export const createErrorReporter = ({
    endpoint = '/api/client-log',
    path = currentPath,
    context,
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

        transport(
            endpoint,
            JSON.stringify({
                ...buildEnvelope(path, context),
                ...report,
            }),
        );
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
