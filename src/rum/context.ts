// The pure part of RUM: payload shapes, context tags, route paths and the WebView classifier.
// No DOM and no Node APIs, so server code, tests and benchmarks can use it; the browser reporters in
// index.ts build on it.

import {
    CONTEXT_KEY_PATTERN,
    MAX_CONTEXT_KEYS,
    MAX_CONTEXT_VALUE_LENGTH,
    MAX_PATH_LENGTH,
    type MetricName,
    type Rating,
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

/**
 * Page path safe to report: no query or hash (they carry search terms and other user data),
 * only route characters, bounded length.
 */
export const sanitizePath = (pathname: string): string => {
    const bare = pathname.split(/[?#]/)[0] ?? '';
    const safe = bare.replace(/[^\w\-./[\]:]/g, '_').slice(0, MAX_PATH_LENGTH);

    return safe.startsWith('/') ? safe : `/${safe}`.slice(0, MAX_PATH_LENGTH);
};
