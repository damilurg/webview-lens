// Pure, Edge/Browser-safe runtime helpers shared across CLI, Node drivers and RUM modules.

/** Type guard for plain key-value objects (excludes null and arrays). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Extracts a human-readable message from any thrown value. */
export const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Runs a step whose failure is expected and harmless (a request the page already dropped, a
 * best-effort restore). The call site says why in a comment; anything else must not use this.
 */
export const bestEffort = (promise: Promise<unknown> | undefined): Promise<void> =>
    (promise ?? Promise.resolve()).then(
        () => undefined,
        () => undefined,
    );

/** Async delay helper. */
export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** The promise's value, or `{ timedOut: true }` after `timeoutMs` (the promise keeps running). */
export const withTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise.then((value) => ({ timedOut: false as const, value })),
            new Promise<{ timedOut: true }>((resolve) => {
                timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/** Awaits `promise` up to `timeoutMs` without leaving a dangling timer behind. */
export const waitWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<void> => {
    await withTimeout(promise, timeoutMs);
};

/** Without trailing slashes: `https://stand.test//` → `https://stand.test`. */
export const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

/** Web content (http or https), not `about:`, `file:`, `chrome-extension:`… Schemes are case-insensitive. */
export const isHttpUrl = (url: string): boolean => /^https?:/i.test(url);

/** The WebSocket URL of an http(s) URL: `http:` → `ws:`, `https:` → `wss:`. */
export const toWebSocketUrl = (url: string): string => url.replace(/^http/i, 'ws');

/** A hostname without IPv6 brackets, as sockets want it: `[::1]` → `::1`. */
export const unbracketHost = (host: string): string => host.replace(/^\[|\]$/g, '');
