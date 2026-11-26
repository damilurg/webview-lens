// Shared Chrome DevTools frontend loader and HTTP link server skeleton (used by Android & iOS links).
// Supports overriding the origin via `DEVTOOLS_FRONTEND_ORIGIN` for corporate mirrors/VPNs.

import http from 'node:http';
import net from 'node:net';

import { errorMessage, stripTrailingSlashes } from '../shared/utils.ts';
import { createLogger } from './logger.ts';

// Silent unless logging is configured (--verbose); callers pass their own callbacks to show it.
const frontendLog = createLogger('devtools');

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
    const baseOrigin = stripTrailingSlashes(origin);
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

export interface DevtoolsHttpServerOptions {
    port: string | number;
    label: string;
    waitingPage: string;
    resolveRedirectPath: () => Promise<string | undefined>;
    onUpgrade: (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => void;
    loadFrontendFile?: (pathname: string) => Promise<FrontendFile>;
    log?: (line: string) => void;
}

export interface DevtoolsServerHandle {
    url: string;
    close(): void;
}

const sharedFrontendLoader = createFrontendLoader();

/**
 * Starts a local HTTP server that serves `/serve_rev/*` assets without CSP, redirects `/` to the
 * active WebView inspector URL (or renders a refreshing waiting page), and delegates WebSocket
 * upgrades to `onUpgrade`.
 */
export const startDevtoolsHttpServer = ({
    port,
    label,
    waitingPage,
    resolveRedirectPath,
    onUpgrade,
    loadFrontendFile = sharedFrontendLoader,
    log = frontendLog.warn,
}: DevtoolsHttpServerOptions): DevtoolsServerHandle => {
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');

        try {
            if (url.pathname.startsWith('/serve_rev/')) {
                const file = await loadFrontendFile(url.pathname);

                response.writeHead(file.status, { 'content-type': file.type });
                response.end(file.body);

                return;
            }

            const location = await resolveRedirectPath();

            if (!location) {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(waitingPage);

                return;
            }

            response.writeHead(302, {
                location,
                'cache-control': 'no-store',
            });
            response.end();
        } catch (error) {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(`${label} unavailable: ${errorMessage(error)}`);
        }
    });

    server.on('upgrade', (request, socket, head) => {
        // An HTTP server hands upgrades a net.Socket; the type says only Duplex.
        if (!(socket instanceof net.Socket)) {
            socket.destroy();

            return;
        }
        onUpgrade(request, socket, head);
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
        log(`${label} on :${port} did not start: ${error.code ?? error.message}`);
    });
    server.listen(Number(port), 'localhost');

    return { url: `http://localhost:${port}`, close: () => server.close() };
};
