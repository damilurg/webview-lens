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

import { getVersion, listPages, pickPage, type DevtoolsPage, type PagePredicate } from './cdp.ts';
import {
    type DevtoolsServerHandle,
    startDevtoolsHttpServer,
    stripCspMeta,
} from './devtools-frontend.ts';
import { connectAndPipe } from './fs-utils.ts';

export { stripCspMeta };

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

export type DevtoolsLink = DevtoolsServerHandle;

export const startDevtoolsLink = ({
    port,
    devtoolsPort,
    isTarget,
    log = console.error,
}: DevtoolsLinkOptions): DevtoolsLink =>
    startDevtoolsHttpServer({
        port,
        label: 'DevTools link',
        waitingPage: WAITING_PAGE,
        log,
        resolveRedirectPath: async () => {
            const page = pickPage(await listPages(devtoolsPort), isTarget);
            const revision = page && frontendRevision(page, await getVersion(devtoolsPort));

            return page && revision ? frontendPath(page.id, port, revision) : undefined;
        },
        // DevTools socket → the phone's debugging port, bytes as they are both ways.
        onUpgrade: (request, socket, head) => {
            if (!request.url?.startsWith('/devtools/')) {
                socket.destroy();

                return;
            }

            connectAndPipe(Number(devtoolsPort), 'localhost', socket, (upstream) => {
                upstream.write(handshakeForDevtools(request, devtoolsPort));
                if (head.length) upstream.write(head);
            });
        },
    });
