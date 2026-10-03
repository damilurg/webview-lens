// Server side of RUM: request handlers on the Fetch API (Request → Response), so they plug into
// Next.js route handlers, Hono, Bun, Deno or a Node adapter without a framework dependency.
//
// The endpoints are public: any client can post to them. Bodies are read as a stream and cut at
// the limit, then checked field by field; only checked fields reach your callback.

import {
    isMetricName,
    isRating,
    MAX_PATH_LENGTH,
    PATH_PATTERN,
    type MetricName,
    type Rating,
} from '../shared/thresholds.ts';

export interface VitalMetric {
    name: MetricName;
    value: number;
    rating: Rating;
    path: string;
    navigationType?: string;
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

/** A metric from `createVitalsReporter`, or null for anything else. */
export const parseVital = (input: unknown): VitalMetric | null => {
    if (!isRecord(input)) return null;

    const { name, value, rating, path, navigationType } = input;

    if (!isMetricName(name) || !isRating(rating)) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(path)) {
        return null;
    }
    if (navigationType !== undefined) {
        if (typeof navigationType !== 'string' || navigationType.length > 40) return null;

        return { name, value, rating, path, navigationType };
    }

    return { name, value, rating, path };
};

const empty = (status: number) => new Response(null, { status });

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

            return empty(STATUS[reason]);
        };

        if (request.method !== 'POST') return reject('method');

        const text = await readLimitedText(request, maxBytes).catch(() => null);

        if (text === null) return reject('too-large');

        const metric = parseVital(parseJson(text));

        if (!metric) return reject('invalid');

        await onMetric(metric, request);

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

            return empty(STATUS[reason]);
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
