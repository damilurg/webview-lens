// DevTools for the phone's WebView page at a fixed address, http://localhost:3300 by default.
//
// Why not the devtools://…/page/<id> link: it cannot be opened as a link (only pasted into the address
// bar), and the page id changes after every app restart. Why not a direct link to
// chrome-devtools-frontend.appspot.com: its CSP (connect-src) blocks ws://localhost in a normal tab,
// so the UI opens empty; chrome://inspect opens it in a special window.
//
// So this server serves the DevTools frontend of the WebView's own revision itself (fetched from
// appspot without its CSP, kept in memory) and redirects / to it with the current page from
// /json/list. The DevTools WebSocket goes through the same server, piped as raw TCP to the forwarded
// port: the debugging port rejects a handshake with a foreign Origin, so the browser's Origin is dropped.

import http from 'node:http';
import net from 'node:net';

import { getVersion, listPages, type DevtoolsPage, type PagePredicate } from './cdp.ts';
import { createFrontendLoader, stripCspMeta } from './devtools-frontend.ts';

export { stripCspMeta };

const loadFrontendFile = createFrontendLoader();

/** Our path of the DevTools UI: the WebView's revision; the page socket goes through our port. */
export const frontendPath = (pageId: string, linkPort: string | number, revision: string): string =>
    `/serve_rev/@${revision}/inspector.html?ws=localhost:${linkPort}/devtools/page/${pageId}`;

interface HandshakeSource {
    method?: string | undefined;
    url?: string | undefined;
    headers: Record<string, string | string[] | undefined>;
}

/** WebSocket handshake for the debugging port: the same request without Origin and with its Host. */
export const handshakeForDevtools = (
    request: HandshakeSource,
    devtoolsPort: string | number,
): string => {
    const headers = Object.entries(request.headers)
        .filter(
            ([name, value]) =>
                value !== undefined && !['origin', 'host'].includes(name.toLowerCase()),
        )
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);

    return [
        `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`,
        `host: localhost:${devtoolsPort}`,
        ...headers,
        '',
        '',
    ].join('\r\n');
};

/** DevTools revision of the WebView: from the page's frontend URL or from WebKit-Version. */
export const frontendRevision = (
    page: Pick<DevtoolsPage, 'devtoolsFrontendUrl'>,
    version: Record<string, unknown>,
): string | undefined =>
    page.devtoolsFrontendUrl?.match(/serve_rev\/@([0-9a-f]+)\//)?.[1] ??
    String(version['WebKit-Version'] ?? '').match(/@([0-9a-f]+)/)?.[1];

const WAITING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>webview-lens · DevTools</title>
<body style="font:16px system-ui;padding:24px">
<p>No WebView page yet: open the WebView screen in the app on the phone.</p>
<p>This page reloads itself and opens DevTools as soon as the page appears.</p>`;

export interface DevtoolsLinkOptions {
    /** Port of this server. */
    port: string | number;
    /** Forwarded DevTools port of the phone. */
    devtoolsPort: string | number;
    /** Which page to open. */
    isTarget: PagePredicate;
    log?: (line: string) => void;
}

export interface DevtoolsLink {
    url: string;
    close(): void;
}

export const startDevtoolsLink = ({
    port,
    devtoolsPort,
    isTarget,
    log = console.error,
}: DevtoolsLinkOptions): DevtoolsLink => {
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');

        try {
            if (url.pathname.startsWith('/serve_rev/')) {
                const file = await loadFrontendFile(url.pathname);

                response.writeHead(file.status, { 'content-type': file.type });
                response.end(file.body);

                return;
            }

            const page = (await listPages(devtoolsPort))?.find(isTarget);
            const revision = page && frontendRevision(page, await getVersion(devtoolsPort));

            if (!page || !revision) {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(WAITING_PAGE);

                return;
            }

            response.writeHead(302, {
                location: frontendPath(page.id, port, revision),
                'cache-control': 'no-store',
            });
            response.end();
        } catch (error) {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(`DevTools unavailable: ${error instanceof Error ? error.message : error}`);
        }
    });

    // DevTools socket → the phone's debugging port, bytes as they are both ways.
    server.on('upgrade', (request, socket, head) => {
        if (!request.url?.startsWith('/devtools/')) {
            socket.destroy();

            return;
        }

        const upstream = net.connect(Number(devtoolsPort), 'localhost', () => {
            upstream.write(handshakeForDevtools(request, devtoolsPort));
            if (head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        const close = () => {
            upstream.destroy();
            socket.destroy();
        };

        upstream.on('error', close);
        socket.on('error', close);
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
        log(`DevTools link on :${port} did not start: ${error.code ?? error.message}`);
    });
    server.listen(Number(port), 'localhost');

    return { url: `http://localhost:${port}`, close: () => server.close() };
};
