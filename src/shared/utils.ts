// Pure, Edge/Browser-safe runtime helpers shared across CLI, Node drivers and RUM modules.

/** Type guard for plain key-value objects (excludes null and arrays). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Extracts a human-readable message from any thrown value. */
export const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Async delay helper. */
export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** Awaits `promise` up to `timeoutMs` without leaving a dangling timer behind. */
export const waitWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            promise,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};
