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
} from '../shared/thresholds.ts';
import { isRecord } from '../shared/utils.ts';

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
import type { TimingPayload, VitalPayload } from './context.ts';

/** A vital as the handler hands it to `onMetric`: the shape the browser reporter sends. */
export type VitalMetric = VitalPayload;

/** A custom timing as the handler hands it to `onTiming`. */
export type TimingMetric = TimingPayload;

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

const isValidPath = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= MAX_PATH_LENGTH && PATH_PATTERN.test(value);

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
    if (!isValidPath(path)) return null;

    const parsedContext = parseContext(context);

    if (parsedContext === null) return null;
    if (
        navigationType !== undefined &&
        (typeof navigationType !== 'string' || navigationType.length > 40)
    ) {
        return null;
    }

    return {
        name,
        value,
        rating,
        path,
        ...(navigationType !== undefined ? { navigationType } : {}),
        ...(parsedContext ? { context: parsedContext } : {}),
    };
};

/** A custom timing from `createTimingReporter`, or null for anything else. */
export const parseTiming = (input: unknown): TimingMetric | null => {
    if (!isRecord(input)) return null;

    const { name, duration, path, context } = input;

    if (typeof name !== 'string' || !TIMING_NAME_PATTERN.test(name)) return null;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
    if (!isValidPath(path)) return null;

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

/**
 * Origins allowed to post from another site (an SSG page on a CDN reporting to an API host):
 * an exact origin, a list, or a predicate. Default: none, same-origin only.
 */
export type AllowOrigin = string | readonly string[] | ((origin: string) => boolean);

const isOriginAllowed = (allowOrigin: AllowOrigin | undefined, origin: string | null): boolean => {
    if (!allowOrigin || !origin) return false;
    if (typeof allowOrigin === 'function') return allowOrigin(origin);
    if (typeof allowOrigin === 'string') return allowOrigin === '*' || allowOrigin === origin;

    return allowOrigin.includes(origin);
};

/** CORS response headers for an allowed cross-origin request; empty for anything else. */
export const corsHeaders = (
    allowOrigin: AllowOrigin | undefined,
    origin: string | null,
): Record<string, string> =>
    origin && isOriginAllowed(allowOrigin, origin)
        ? { 'access-control-allow-origin': origin, vary: 'origin' }
        : {};

const withHeaders = (response: Response, headers: Record<string, string>): Response => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);

    return response;
};

interface JsonPostHandlerConfig<T> {
    maxBytes: number;
    parse: (body: unknown, request: Request) => T | null;
    onValid: (payload: T, request: Request) => void | Promise<void>;
    onReject?: ((reason: RejectReason, request: Request) => void) | undefined;
    allowOrigin?: AllowOrigin | undefined;
}

/**
 * Shared Fetch API POST pipeline: CORS preflight for allowed origins, method guard (405+Allow),
 * streaming cap (413), JSON parse & validate (400), callback, 204.
 */
const createJsonPostHandler =
    <T>({ maxBytes, parse, onValid, onReject, allowOrigin }: JsonPostHandlerConfig<T>) =>
    async (request: Request): Promise<Response> => {
        const cors = corsHeaders(allowOrigin, request.headers.get('origin'));
        const reject = (reason: RejectReason) => {
            onReject?.(reason, request);

            return withHeaders(rejectResponse(reason, 'POST'), cors);
        };

        if (request.method === 'OPTIONS' && Object.keys(cors).length > 0) {
            return empty(204, {
                ...cors,
                'access-control-allow-methods': 'POST',
                'access-control-allow-headers': 'content-type',
                'access-control-max-age': '86400',
            });
        }
        if (request.method !== 'POST') return reject('method');

        const text = await readLimitedText(request, maxBytes).catch(() => null);

        if (text === null) return reject('too-large');

        const payload = parse(parseJson(text), request);

        if (payload === null) return reject('invalid');

        await onValid(payload, request);

        return withHeaders(empty(204), cors);
    };

export interface VitalsHandlerOptions {
    /** Cross-origin pages allowed to post here (SSG on another host). Default: same-origin only. */
    allowOrigin?: AllowOrigin;
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
export const createVitalsHandler = ({
    onMetric,
    onReject,
    allowOrigin,
    maxBytes = 2 * 1024,
}: VitalsHandlerOptions) =>
    createJsonPostHandler({
        maxBytes,
        parse: parseVital,
        onValid: onMetric,
        onReject,
        allowOrigin,
    });

export interface TimingsHandlerOptions {
    /** Cross-origin pages allowed to post here (SSG on another host). Default: same-origin only. */
    allowOrigin?: AllowOrigin;
    onTiming: (timing: TimingMetric, request: Request) => void | Promise<void>;
    onReject?: (reason: RejectReason, request: Request) => void;
    /** Default 2 KiB. */
    maxBytes?: number;
}

/** Handler for POST /api/timings: custom app/bridge timings from `createTimingReporter`. */
export const createTimingsHandler = ({
    onTiming,
    onReject,
    allowOrigin,
    maxBytes = 2 * 1024,
}: TimingsHandlerOptions) =>
    createJsonPostHandler({
        maxBytes,
        parse: parseTiming,
        onValid: onTiming,
        onReject,
        allowOrigin,
    });

export interface ClientLogEntry {
    message: string;
    fields: Record<string, unknown>;
    userAgent: string | null;
    referer: string | null;
}

export interface ClientLogHandlerOptions {
    /** Cross-origin pages allowed to post here (SSG on another host). Default: same-origin only. */
    allowOrigin?: AllowOrigin;
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
export const createClientLogHandler = ({
    onLog,
    onReject,
    allowOrigin,
    maxBytes = 16 * 1024,
    maxFields = 20,
    maxValueLength = 1000,
}: ClientLogHandlerOptions) => {
    const truncate = (value: unknown): unknown =>
        typeof value === 'string' && value.length > maxValueLength
            ? `${value.slice(0, maxValueLength)}…`
            : value;

    return createJsonPostHandler<ClientLogEntry>({
        maxBytes,
        onReject,
        allowOrigin,
        onValid: onLog,
        parse: (body, request) => {
            if (!isRecord(body) || Object.keys(body).length > maxFields) return null;

            const { message, ...rest } = Object.fromEntries(
                Object.entries(body).map(([key, value]) => [key, truncate(value)]),
            );

            return {
                message: typeof message === 'string' ? message : 'browser error',
                fields: rest,
                userAgent: request.headers.get('user-agent'),
                referer: request.headers.get('referer'),
            };
        },
    });
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
        let response: Response;

        try {
            response = await handler(toFetchRequest(req));
        } catch {
            // A throwing callback or a malformed Host header must not become an unhandled
            // rejection that takes down a bare node:http server.
            res.statusCode = 500;
            res.end();

            return;
        }

        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));

        if (!response.body) {
            res.end();

            return;
        }

        res.end(new Uint8Array(await response.arrayBuffer()));
    };

const toFetchRequest = (req: NodeIncomingMessage): Request => {
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

    return new Request(url, init);
};
