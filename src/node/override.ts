// Serves a remote origin from a local server inside the phone's WebView.
//
// The WebView stays on the https origin of the stand (many apps forbid cleartext http:
// ERR_CLEARTEXT_NOT_PERMITTED), and every request to that origin is intercepted through the Chrome
// DevTools Protocol (Fetch domain) and fulfilled from the local server. The native bridge stays real,
// cookies land on the stand's domain, and a `'self'` CSP still matches.
//
// Fetch does not intercept WebSockets. Sockets under the bridged prefixes (Next.js dev: HMR and the
// RSC debug channel, without which the dev client never hydrates) go through a stub WebSocket in the
// page and a CDP binding: page → binding → this process → local server, and back via Runtime.evaluate.

import { connectCdp, type DevtoolsPage } from './cdp.ts';

/** Headers fetch computes itself, or that must not reach the WebView as they are. */
const DROP_RESPONSE = new Set([
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'set-cookie',
]);
const DROP_REQUEST = new Set([
    'host',
    'origin',
    'referer',
    'cookie',
    'connection',
    'accept-encoding',
]);

const BINDING = '__webviewLensWsSend';
const RECEIVER = '__webviewLensWsRecv';

interface PausedRequest {
    requestId: string;
    request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        postData?: string;
        postDataEntries?: { bytes?: string }[];
    };
}

interface BindingCall {
    name: string;
    payload: string;
}

interface BridgeMessage {
    sid: number;
    type: 'open' | 'send' | 'close';
    url?: string;
    data?: string;
    binary?: boolean;
}

/** Node's WebSocket (undici) takes headers in its second argument, unlike the DOM signature. */
const NodeWebSocket = WebSocket as unknown as new (
    url: string,
    init?: { headers?: Record<string, string> },
) => WebSocket;

export interface OverrideLogger {
    request(line: string): void;
    error(line: string): void;
}

export interface OverrideOptions {
    page: DevtoolsPage;
    /** Origin the WebView shows, such as https://stand.example.com. */
    remote: string;
    /** Local server, such as http://localhost:3000. */
    local: string;
    /** WebSocket path prefixes bridged to the local server. Default: Next.js `/_next/`. */
    wsPrefixes?: readonly string[];
    /** Paths not logged per request. Default: Next.js static and dev overlay files. */
    quietPrefixes?: readonly string[];
    logger?: OverrideLogger;
}

export interface OverrideSession {
    reload(): Promise<void>;
    close(): void;
    /** Settles when the WebView page goes away. */
    closed: Promise<void>;
}

/** Page script replacing WebSocket for URLs under the bridged prefixes. */
export const bridgeShim = (remote: string, wsPrefixes: readonly string[]): string => `(() => {
    const Native = window.WebSocket;
    const prefixes = ${JSON.stringify(wsPrefixes.map((prefix) => remote.replace(/^http/, 'ws') + prefix))};
    const open = new Map();
    let next = 0;
    const b64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
    const post = (message) => ${BINDING}(JSON.stringify(message));
    class Bridged extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor(url) {
            super();
            this.url = String(url); this.readyState = 0; this.binaryType = 'blob';
            this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0;
            this.sid = ++next; open.set(this.sid, this);
            post({ sid: this.sid, type: 'open', url: this.url.replace(/^ws/, 'http') });
        }
        send(data) {
            const binary = typeof data !== 'string';
            const go = (payload) => post({ sid: this.sid, type: 'send', data: payload, binary });
            if (!binary) go(data);
            else if (data instanceof Blob) data.arrayBuffer().then((b) => go(b64(b)));
            else go(b64(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
        }
        close() { this.readyState = 2; post({ sid: this.sid, type: 'close' }); }
        _emit(type, init) {
            const event = type === 'message' ? new MessageEvent('message', init) : type === 'close' ? new CloseEvent('close', { code: 1000 }) : new Event(type);
            this.dispatchEvent(event);
            this['on' + type]?.(event);
        }
    }
    window.${RECEIVER} = (sid, type, data, binary) => {
        const ws = open.get(sid);
        if (!ws) return;
        if (type === 'open') { ws.readyState = 1; ws._emit('open'); }
        else if (type === 'message') {
            let payload = data;
            if (binary) { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); payload = ws.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]); }
            ws._emit('message', { data: payload });
        } else if (type === 'error') ws._emit('error');
        else if (type === 'close') { ws.readyState = 3; open.delete(sid); ws._emit('close'); }
    };
    window.WebSocket = new Proxy(Native, {
        construct(target, args) { const url = String(args[0]); return prefixes.some((p) => url.startsWith(p)) ? new Bridged(args[0]) : new target(...args); },
    });
})();`;

/** Request headers for the local server: cookies of the stand's domain, Origin and Referer rewritten. */
export const toLocalHeaders = (
    headers: Record<string, string>,
    cookies: readonly { name: string; value: string }[],
    local: string,
    toLocal: (url: string) => string,
): Record<string, string> => {
    const result = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !DROP_REQUEST.has(name.toLowerCase())),
    );
    const referer = headers.Referer ?? headers.referer;

    if (cookies.length) result.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (headers.Origin ?? headers.origin) result.origin = local;
    if (referer) result.referer = toLocal(referer);

    return result;
};

export const startOverride = async ({
    page,
    remote,
    local,
    wsPrefixes = ['/_next/'],
    quietPrefixes = ['/_next/static', '/__nextjs'],
    logger = { request: console.log, error: console.error },
}: OverrideOptions): Promise<OverrideSession> => {
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    const toLocal = (url: string) => local + url.slice(remote.length);
    const toRemote = (url: string) =>
        url.startsWith(local) ? remote + url.slice(local.length) : url;
    let isLocalDownReported = false;

    const handle = async ({ requestId, request }: PausedRequest) => {
        const url = toLocal(request.url);

        try {
            const { cookies } = await cdp.send<{ cookies: { name: string; value: string }[] }>(
                'Network.getCookies',
                { urls: [request.url] },
            );
            const body = request.postDataEntries
                ? Buffer.concat(
                      request.postDataEntries.map((e) => Buffer.from(e.bytes ?? '', 'base64')),
                  )
                : request.postData;
            const response = await fetch(url, {
                method: request.method,
                headers: toLocalHeaders(request.headers, cookies, local, toLocal),
                body: body === undefined || typeof body === 'string' ? body : new Uint8Array(body),
                redirect: 'manual',
            });
            const responseHeaders: { name: string; value: string }[] = [];

            response.headers.forEach((value, name) => {
                if (DROP_RESPONSE.has(name)) return;
                responseHeaders.push({
                    name,
                    value: name === 'location' ? toRemote(value) : value,
                });
            });
            for (const cookie of response.headers.getSetCookie()) {
                responseHeaders.push({ name: 'set-cookie', value: cookie });
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            await cdp.send('Fetch.fulfillRequest', {
                requestId,
                responseCode: response.status,
                responseHeaders,
                body: buffer.toString('base64'),
            });

            const path = new URL(url).pathname;

            if (!quietPrefixes.some((prefix) => path.startsWith(prefix))) {
                logger.request(`${response.status} ${request.method} ${path}`);
            }
            isLocalDownReported = false;
        } catch (error) {
            const cause = error instanceof Error ? error.cause : undefined;
            const code =
                (typeof cause === 'object' && cause && 'code' in cause && String(cause.code)) ||
                (error instanceof Error ? error.message : String(error));

            if (code !== 'ECONNREFUSED') {
                logger.error(`FAIL ${request.method} ${url}: ${code}`);
            } else if (!isLocalDownReported) {
                isLocalDownReported = true;
                logger.error(`Local server ${local} does not respond`);
            }
            await cdp
                .send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' })
                .catch(() => undefined);
        }
    };

    const sockets = new Map<number, WebSocket>();
    const deliver = (sid: number, type: string, data = '', binary = false) =>
        cdp
            .send('Runtime.evaluate', {
                expression: `window.${RECEIVER}?.(${sid}, ${JSON.stringify(type)}, ${JSON.stringify(data)}, ${binary})`,
            })
            .catch(() => undefined);

    const onBinding = ({ name, payload }: BindingCall) => {
        if (name !== BINDING) return;

        const { sid, type, url, data = '', binary = false }: BridgeMessage = JSON.parse(payload);

        if (type === 'open' && url) {
            const socket = new NodeWebSocket(toLocal(url).replace(/^http/, 'ws'), {
                headers: { origin: local },
            });

            socket.binaryType = 'arraybuffer';
            socket.onopen = () => deliver(sid, 'open');
            socket.onmessage = ({ data: frame }) =>
                typeof frame === 'string'
                    ? deliver(sid, 'message', frame)
                    : deliver(sid, 'message', Buffer.from(frame).toString('base64'), true);
            socket.onclose = () => {
                sockets.delete(sid);
                deliver(sid, 'close');
            };
            socket.onerror = () => deliver(sid, 'error');
            sockets.set(sid, socket);

            return;
        }
        if (type === 'send') {
            const socket = sockets.get(sid);

            if (socket?.readyState === WebSocket.OPEN)
                socket.send(binary ? Buffer.from(data, 'base64') : data);

            return;
        }
        if (type === 'close') sockets.get(sid)?.close();
    };

    cdp.on<PausedRequest>('Fetch.requestPaused', (params) => void handle(params));
    cdp.on<BindingCall>('Runtime.bindingCalled', onBinding);

    const shim = bridgeShim(remote, wsPrefixes);

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: BINDING });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });

    const check = await cdp.send<{ exceptionDetails?: { exception?: { description?: string } } }>(
        'Runtime.evaluate',
        { expression: `new Function(${JSON.stringify(shim)}); 'ok'` },
    );

    if (check.exceptionDetails) {
        throw new Error(
            `WebSocket bridge script: ${check.exceptionDetails.exception?.description}`,
        );
    }

    await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: `${remote}/*`, requestStage: 'Request' }],
    });

    const reload = async () => {
        await cdp.send('Page.reload', { ignoreCache: true });
    };

    if (page.url.startsWith(remote)) await reload();
    else await cdp.send('Page.navigate', { url: `${remote}/` });

    void cdp.closed.then(() => {
        for (const socket of sockets.values()) socket.close();
        sockets.clear();
    });

    return { reload, close: () => cdp.close(), closed: cdp.closed };
};
