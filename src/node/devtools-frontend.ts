// Shared in-memory cached loader for Chrome DevTools frontend assets (used by Android & iOS links).
// Supports overriding the origin via `DEVTOOLS_FRONTEND_ORIGIN` for corporate mirrors/VPNs.

export const DEFAULT_FRONTEND_ORIGIN = 'https://chrome-devtools-frontend.appspot.com';

export interface FrontendFile {
    status: number;
    type: string;
    body: Buffer;
}

export interface FrontendLoaderOptions {
    /** Base origin hosting `/serve_rev/*`. Defaults to `DEVTOOLS_FRONTEND_ORIGIN` or appspot. */
    origin?: string;
    fetchImpl?: typeof fetch;
}

/** The UI's CSP blocks ws://localhost: removed from headers (not forwarded) and from `<meta>`. */
export const stripCspMeta = (html: string): string =>
    html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');

/** Creates a memoized loader for immutable `/serve_rev/*` DevTools frontend files. */
export const createFrontendLoader = ({
    origin = process.env.DEVTOOLS_FRONTEND_ORIGIN ?? DEFAULT_FRONTEND_ORIGIN,
    fetchImpl = fetch,
}: FrontendLoaderOptions = {}): ((pathname: string) => Promise<FrontendFile>) => {
    const baseOrigin = origin.replace(/\/+$/, '');
    const cache = new Map<string, FrontendFile>();

    return async (pathname: string): Promise<FrontendFile> => {
        const cached = cache.get(pathname);

        if (cached) return cached;

        const response = await fetchImpl(baseOrigin + pathname);

        if (!response.ok) {
            return { status: response.status, type: 'text/plain', body: Buffer.alloc(0) };
        }

        const type = response.headers.get('content-type') ?? 'application/octet-stream';
        const raw = Buffer.from(await response.arrayBuffer());
        const body = type.includes('text/html')
            ? Buffer.from(stripCspMeta(raw.toString('utf8')))
            : raw;
        const file: FrontendFile = { status: 200, type, body };

        cache.set(pathname, file);

        return file;
    };
};
