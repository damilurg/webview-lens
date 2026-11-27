// Browser side of RUM: Web Vitals and uncaught errors from real users, sent to your own endpoint.
//
// No dependency on a metrics library: feed it from `web-vitals` (onLCP(report)), Next.js
// (useReportWebVitals(report)) or anything else that yields { name, value, rating? }.
// Delivery uses sendBeacon, which survives the WebView being closed: CLS and INP are final only then.

import { isMetricName, isRating, rate, TIMING_NAME_PATTERN } from '../shared/thresholds.ts';
import {
    type ContextInput,
    type MetricLike,
    sanitizeContext,
    sanitizePath,
    type TimingPayload,
    type VitalPayload,
} from './context.ts';

export {
    METRIC_NAMES,
    type MetricName,
    rate,
    type Rating,
    THRESHOLDS,
} from '../shared/thresholds.ts';
export {
    type ContextInput,
    detectWebViewEnv,
    type MetricLike,
    sanitizeContext,
    sanitizePath,
    type TimingPayload,
    type VitalPayload,
    type WebViewEnv,
} from './context.ts';

/** Sends a JSON body to an endpoint without waiting for the answer. */
export type Transport = (endpoint: string, body: string) => void;

/** True during SSR / SSG prerender (Node, Deno, Bun, Edge workers): no document to report from. */
export const isServerRuntime = (): boolean =>
    typeof window === 'undefined' || typeof document === 'undefined';

/**
 * Whether `endpoint` is on another origin than the page (an SSG site on a CDN posting to an API
 * host). Relative endpoints are same-origin.
 */
export const isCrossOriginEndpoint = (
    endpoint: string,
    pageHref: string = typeof location === 'undefined' ? '' : location.href,
): boolean => {
    if (!pageHref) return false;
    try {
        return new URL(endpoint, pageHref).origin !== new URL(pageHref).origin;
    } catch {
        return false;
    }
};

/**
 * sendBeacon, or `fetch` with keepalive where the beacon is unavailable or refused. A no-op on the
 * server, so reporters can be created in code shared by SSR and the browser.
 *
 * Same-origin bodies go as `application/json`. Cross-origin ones go as `text/plain`, a CORS-safelisted
 * type that needs no preflight; the handlers parse the body whatever its Content-Type.
 */
export const beaconTransport: Transport = (endpoint, body) => {
    if (isServerRuntime()) return;

    const type = isCrossOriginEndpoint(endpoint) ? 'text/plain;charset=UTF-8' : 'application/json';
    const isQueued =
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(endpoint, new Blob([body], { type }));

    if (isQueued) return;

    fetch(endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'content-type': type },
        // Fire-and-forget telemetry: a lost beacon must never surface as an app error.
    }).catch(() => undefined);
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
 * On the server (SSR / SSG prerender) it does nothing and returns a no-op.
 */
export const captureGlobalErrors = (
    report: (fields: Record<string, unknown>) => void,
    target?: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): (() => void) => {
    // SSR / SSG prerender: nothing to listen to; safe to call from shared app setup code.
    if (!target && typeof window === 'undefined') return () => undefined;

    const host = target ?? window;
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

    host.addEventListener('error', onError);
    host.addEventListener('unhandledrejection', onRejection);

    return () => {
        host.removeEventListener('error', onError);
        host.removeEventListener('unhandledrejection', onRejection);
    };
};
