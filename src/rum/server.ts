// Server side of RUM: request handlers on the Fetch API (Request → Response), so they plug into
// Next.js route handlers, Hono, Bun, Deno or a Node adapter without a framework dependency.
//
// The endpoints are public: any client can post to them. Bodies are read as a stream and cut at
// the limit, then checked field by field; only checked fields reach your callback.

import {
    CONTEXT_KEY_PATTERN,
    isMetricName,
    isRating,
    MAX_CONTEXT_KEYS,
    MAX_CONTEXT_VALUE_LENGTH,
    MAX_PATH_LENGTH,
    PATH_PATTERN,
    TIMING_NAME_PATTERN,
    type MetricName,
    type Rating,
} from '../shared/thresholds.ts';

export {
    createMetricsHandler,
    createRumAggregator,
    type ErrorCounter,
    escapePromLabel,
    type MetricsHandlerOptions,
    type RumAggregator,
    type RumAggregatorOptions,
    type RumSnapshot,
    type TimingSummary,
    toPrometheusText,
    type VitalSummary,
} from './aggregator.ts';

export interface VitalMetric {
    name: MetricName;
    value: number;
    rating: Rating;
    path: string;
    navigationType?: string;
    context?: Record<string, string>;
}

export interface TimingMetric {
    name: string;
    duration: number;
    path: string;
    context?: Record<string, string>;
}

export type RejectReason = 'method' | 'too-large' | 'invalid';

/**
 * Request body as text, at most maxBytes. Reading stops at the limit, so a huge body (chunked,
 * without Content-Length too) never sits in memory whole. null: the body is over the limit.
 */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
    if (Number(request.headers.get('content-length')) > maxBytes) return null;
    if (!request.body) return '';

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.byteLength;

        if (size > maxBytes) {
            await reader.cancel();

            return null;
        }

        chunks.push(value);
    }

    const all = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(all);
}

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates optional context tags; returns undefined when absent or null when malformed. */
export const parseContext = (input: unknown): Record<string, string> | undefined | null => {
    if (input === undefined) return undefined;
    if (!isRecord(input)) return null;

    const entries = Object.entries(input);

    if (entries.length > MAX_CONTEXT_KEYS) return null;

    const out: Record<string, string> = {};

    for (const [key, value] of entries) {
        if (!CONTEXT_KEY_PATTERN.test(key) || key === '__proto__' || key === 'constructor') {
            return null;
        }
        if (typeof value !== 'string' || value.length > MAX_CONTEXT_VALUE_LENGTH) return null;
        out[key] = value;
    }

    return out;
};

/** A metric from `createVitalsReporter`, or null for anything else. */
export const parseVital = (input: unknown): VitalMetric | null => {
    if (!isRecord(input)) return null;

    const { name, value, rating, path, navigationType, context } = input;

    if (!isMetricName(name) || !isRating(rating)) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(path)) {
        return null;
    }

    const parsedContext = parseContext(context);

    if (parsedContext === null) return null;

    if (navigationType !== undefined) {
        if (typeof navigationType !== 'string' || navigationType.length > 40) return null;

        return {
            name,
            value,
            rating,
            path,
            navigationType,
            ...(parsedContext ? { context: parsedContext } : {}),
        };
    }

    return {
        name,
        value,
        rating,
        path,
        ...(parsedContext ? { context: parsedContext } : {}),
    };
};

/** A custom timing from `createTimingReporter`, or null for anything else. */
export const parseTiming = (input: unknown): TimingMetric | null => {
    if (!isRecord(input)) return null;

    const { name, duration, path, context } = input;

    if (typeof name !== 'string' || !TIMING_NAME_PATTERN.test(name)) return null;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
    if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(path)) {
        return null;
    }

    const parsedContext = parseContext(context);

    if (parsedContext === null) return null;

    return {
        name,
        duration,
        path,
        ...(parsedContext ? { context: parsedContext } : {}),
    };
};

const empty = (status: number, headers?: Record<string, string>) =>
    new Response(null, headers ? { status, headers } : { status });

const rejectResponse = (reason: RejectReason, allow = 'POST') =>
    reason === 'method' ? empty(STATUS[reason], { allow }) : empty(STATUS[reason]);

const STATUS: Record<RejectReason, number> = { method: 405, 'too-large': 413, invalid: 400 };

export interface VitalsHandlerOptions {
    onMetric: (metric: VitalMetric, request: Request) => void | Promise<void>;
    onReject?: (reason: RejectReason, request: Request) => void;
    /** One metric is a couple of hundred bytes. Default 2 KiB. */
    maxBytes?: number;
}

/**
 * Handler for POST /api/vitals.
 *
 * @example Next.js: `export const POST = createVitalsHandler({ onMetric: (m) => log.info(m) });`
 */
export const createVitalsHandler =
    ({ onMetric, onReject, maxBytes = 2 * 1024 }: VitalsHandlerOptions) =>
    async (request: Request): Promise<Response> => {
        const reject = (reason: RejectReason) => {
            onReject?.(reason, request);

            return rejectResponse(reason, 'POST');
        };

        if (request.method !== 'POST') return reject('method');

        const text = await readLimitedText(request, maxBytes).catch(() => null);

        if (text === null) return reject('too-large');

        const metric = parseVital(parseJson(text));

        if (!metric) return reject('invalid');

        await onMetric(metric, request);

        return empty(204);
    };

export interface TimingsHandlerOptions {
    onTiming: (timing: TimingMetric, request: Request) => void | Promise<void>;
    onReject?: (reason: RejectReason, request: Request) => void;
    /** Default 2 KiB. */
    maxBytes?: number;
}

/** Handler for POST /api/timings: custom app/bridge timings from `createTimingReporter`. */
export const createTimingsHandler =
    ({ onTiming, onReject, maxBytes = 2 * 1024 }: TimingsHandlerOptions) =>
    async (request: Request): Promise<Response> => {
        const reject = (reason: RejectReason) => {
            onReject?.(reason, request);

            return rejectResponse(reason, 'POST');
        };

        if (request.method !== 'POST') return reject('method');

        const text = await readLimitedText(request, maxBytes).catch(() => null);

        if (text === null) return reject('too-large');

        const timing = parseTiming(parseJson(text));

        if (!timing) return reject('invalid');

        await onTiming(timing, request);

        return empty(204);
    };

export interface ClientLogEntry {
    message: string;
    fields: Record<string, unknown>;
    userAgent: string | null;
    referer: string | null;
}

export interface ClientLogHandlerOptions {
    onLog: (entry: ClientLogEntry, request: Request) => void | Promise<void>;
    onReject?: (reason: RejectReason, request: Request) => void;
    /** Default 16 KiB. */
    maxBytes?: number;
    /** Default 20. */
    maxFields?: number;
    /** Longer strings are cut and end with `…`. Default 1000. */
    maxValueLength?: number;
}

/** Handler for POST /api/client-log: errors from the browser, so the server log shows them. */
export const createClientLogHandler =
    ({
        onLog,
        onReject,
        maxBytes = 16 * 1024,
        maxFields = 20,
        maxValueLength = 1000,
    }: ClientLogHandlerOptions) =>
    async (request: Request): Promise<Response> => {
        const reject = (reason: RejectReason) => {
            onReject?.(reason, request);

            return rejectResponse(reason, 'POST');
        };

        if (request.method !== 'POST') return reject('method');

        const text = await readLimitedText(request, maxBytes).catch(() => null);

        if (text === null) return reject('too-large');

        const body = parseJson(text);

        if (!isRecord(body) || Object.keys(body).length > maxFields) return reject('invalid');

        const truncate = (value: unknown): unknown =>
            typeof value === 'string' && value.length > maxValueLength
                ? `${value.slice(0, maxValueLength)}…`
                : value;
        const { message, ...rest } = Object.fromEntries(
            Object.entries(body).map(([key, value]) => [key, truncate(value)]),
        );

        await onLog(
            {
                message: typeof message === 'string' ? message : 'browser error',
                fields: rest,
                userAgent: request.headers.get('user-agent'),
                referer: request.headers.get('referer'),
            },
            request,
        );

        return empty(204);
    };

/** Structural subset of Node's `http.IncomingMessage` so this module stays Edge-runtime safe. */
export interface NodeIncomingMessage extends AsyncIterable<Uint8Array | string> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
}

/** Structural subset of Node's `http.ServerResponse`. */
export interface NodeServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): unknown;
    end(chunk?: Uint8Array | string): unknown;
}

/**
 * Adapts a Fetch API handler (`createVitalsHandler` / `createClientLogHandler`) to `node:http`,
 * Express, Connect, or NestJS without any runtime dependencies.
 */
export const toNodeHandler =
    (handler: (request: Request) => Promise<Response>) =>
    async (req: NodeIncomingMessage, res: NodeServerResponse): Promise<void> => {
        const method = req.method ?? 'GET';
        const rawHost = req.headers.host;
        const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost) ?? 'localhost';
        const url = new URL(req.url ?? '/', `http://${host}`).toString();
        const headers = new Headers();

        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (!Array.isArray(value)) {
                headers.set(name, value);
                continue;
            }
            for (const item of value) headers.append(name, item);
        }

        const init: RequestInit & { duplex?: 'half' } = { method, headers };

        if (method !== 'GET' && method !== 'HEAD') {
            const iterator = req[Symbol.asyncIterator]();
            const encoder = new TextEncoder();

            init.body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    const { done, value } = await iterator.next();

                    if (done) {
                        controller.close();

                        return;
                    }
                    controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
                },
                cancel() {
                    void iterator.return?.();
                },
            });
            init.duplex = 'half';
        }

        const response = await handler(new Request(url, init));

        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));

        if (!response.body) {
            res.end();

            return;
        }

        const body = new Uint8Array(await response.arrayBuffer());

        res.end(body);
    };
