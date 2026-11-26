// Serves a remote origin from a local server inside the phone's WebView.
//
// The WebView stays on the https origin of the stand (many apps forbid cleartext http:
// ERR_CLEARTEXT_NOT_PERMITTED), and every request to that origin is intercepted through the Chrome
// DevTools Protocol (Fetch domain) and fulfilled from the local server. The native bridge stays real,
// cookies land on the stand's domain, and a `'self'` CSP still matches.
//
// Fetch does not intercept WebSockets. Sockets under the bridged prefixes (or configured separate
// HMR ports) go through a stub WebSocket in the page and a CDP binding:
// page → binding → this process → local server, and back via Runtime.evaluate.

import { bool, type Decoder, num, oneOf, parseJson, someOf, str } from '../shared/decode.ts';
import { bestEffort, errorMessage, isRecord } from '../shared/utils.ts';
import { type Cdp, connectCdp, type DevtoolsPage } from './cdp.ts';
import { BINDING, bridgeShim, RECEIVER } from './bridge-shim.ts';
import { createLogger } from './logger.ts';
import {
    type BindingCall,
    decodeBindingCall,
    decodeCookies,
    decodeEvaluateResult,
    decodePausedRequest,
    type PausedRequest,
    sendDecoded,
    subscribe,
} from './protocol.ts';
import { attachTelemetry, type TelemetryOptions } from './telemetry.ts';

const debugLog = createLogger('override');

export { bridgeShim };

/** Headers fetch computes itself, or that must not reach the WebView as they are. */
export const DROP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
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

/** A frame the bridge shim posts through the binding. Any page script can call it: untrusted. */
interface BridgeMessage {
    sid: number;
    type: 'open' | 'send' | 'close';
    url?: string;
    data: string;
    binary: boolean;
    /** WebSocket subprotocols the page asked for (Vite HMR requires `vite-hmr`). */
    protocols: string[];
}

const decodeBridgeMessage: Decoder<BridgeMessage> = (input) => {
    if (!isRecord(input)) return undefined;

    const sid = num(input.sid);
    const type = oneOf(['open', 'send', 'close'])(input.type);
    const data = input.data === undefined ? '' : str(input.data);

    if (sid === undefined || !Number.isInteger(sid) || !type || data === undefined)
        return undefined;

    const url = str(input.url);

    return {
        sid,
        type,
        ...(url !== undefined ? { url } : {}),
        data,
        binary: bool(input.binary) ?? false,
        protocols: (someOf(str)(input.protocols) ?? []).slice(0, 8),
    };
};

export type SsePolicy = 'fail' | 'continue';

export interface OverrideLogger {
    request(line: string): void;
    error(line: string): void;
}

export interface UrlMapperOptions {
    remote: string;
    local: string;
    remoteBase?: string;
    localBase?: string;
}

export interface UrlMapper {
    readonly remoteOrigin: string;
    readonly localOrigin: string;
    readonly remoteBase: string;
    readonly localBase: string;
    readonly remotePrefix: string;
    readonly localPrefix: string;
    readonly entryUrl: string;
    readonly fetchPatterns: readonly { urlPattern: string; requestStage: 'Request' }[];
    matchesRemote(url: string): boolean;
    toLocal(url: string): string;
    toRemote(url: string): string;
}

export interface OverrideOptions {
    page: DevtoolsPage;
    /** Origin the WebView shows, such as https://stand.example.com. */
    remote: string;
    /** Local server, such as http://localhost:3000. */
    local: string;
    /** Optional base path on the stand (e.g. `/shop`) mapped to `localBase`. */
    remoteBase?: string;
    /** Optional base path on the local server (default: `/`). */
    localBase?: string;
    /** WebSocket path prefixes bridged to the local server. Default: Next.js `/_next/`. */
    wsPrefixes?: readonly string[];
    /** Extra local HMR ports bridged over CDP (solves separate-port Vite/Webpack HMR & Mixed Content). */
    hmrPorts?: readonly number[];
    /** Paths not logged per request. Default: Next.js static and dev overlay files. */
    quietPrefixes?: readonly string[];
    /** Paths bypassed directly to the stand via `Fetch.continueRequest` (e.g. live SSE streams). */
    bypassPrefixes?: readonly string[];
    /** What to do when the local server responds with `text/event-stream`. Default: `'fail'`. */
    ssePolicy?: SsePolicy;
    /**
     * Reverse-proxy mode for SSR: send `X-Forwarded-*` / `Forwarded` describing the stand and keep
     * Origin/Referer as the stand's. Default: false (the local server sees itself as the origin).
     */
    forwardedHeaders?: boolean;
    /** Custom CDP connector (for testing or custom transports). */
    connect?: (webSocketDebuggerUrl: string) => Promise<Cdp>;
    /** Custom fetch implementation (for testing or custom transports). */
    fetchImpl?: typeof fetch;
    /** Stream console logs, uncaught exceptions and network errors from the page to the terminal. */
    telemetry?: boolean | TelemetryOptions;
    logger?: OverrideLogger;
}

export interface OverrideSession {
    reload(): Promise<void>;
    close(): void;
    /** Settles when the WebView page goes away. */
    closed: Promise<void>;
}

/** Normalizes a URL base path: `""` or `"/"` → `""`, `"shop/"` → `"/shop"`. */
export const normalizeBasePath = (base = ''): string => {
    const trimmed = base.trim().replace(/\/+$/, '');

    if (!trimmed || trimmed === '/') return '';

    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const hasBoundary = (value: string, prefix: string): boolean => {
    if (!value.startsWith(prefix)) return false;

    const next = value[prefix.length];

    return next === undefined || next === '/' || next === '?' || next === '#';
};

const joinWithBoundary = (prefix: string, rest: string, hasBase: boolean): string => {
    if (rest === '' || rest.startsWith('?') || rest.startsWith('#')) {
        return prefix + (hasBase ? rest : `/${rest}`);
    }

    return prefix + rest;
};

/** Maps URLs and redirect Locations between remote (+ optional subpath) and local (+ optional subpath). */
export const createUrlMapper = ({
    remote,
    local,
    remoteBase = '',
    localBase = '',
}: UrlMapperOptions): UrlMapper => {
    const remoteOrigin = remote.replace(/\/+$/, '');
    const localOrigin = local.replace(/\/+$/, '');
    const rBase = normalizeBasePath(remoteBase);
    const lBase = normalizeBasePath(localBase);
    const remotePrefix = remoteOrigin + rBase;
    const localPrefix = localOrigin + lBase;

    const matchesRemote = (url: string): boolean => hasBoundary(url, remotePrefix);

    const toLocal = (url: string): string => {
        if (!matchesRemote(url)) return url;

        return joinWithBoundary(localPrefix, url.slice(remotePrefix.length), Boolean(lBase));
    };

    const toRemote = (url: string): string => {
        if (hasBoundary(url, localPrefix)) {
            return joinWithBoundary(remotePrefix, url.slice(localPrefix.length), Boolean(rBase));
        }
        if (rBase !== lBase && url.startsWith('/') && !url.startsWith('//')) {
            if (!lBase) return rBase + url;
            if (hasBoundary(url, lBase)) {
                const rest = url.slice(lBase.length);

                return rBase + rest || '/';
            }
        }

        return url;
    };

    const fetchPatterns: { urlPattern: string; requestStage: 'Request' }[] = rBase
        ? [
              { urlPattern: remotePrefix, requestStage: 'Request' },
              { urlPattern: `${remotePrefix}/*`, requestStage: 'Request' },
          ]
        : [{ urlPattern: `${remoteOrigin}/*`, requestStage: 'Request' }];

    return {
        remoteOrigin,
        localOrigin,
        remoteBase: rBase,
        localBase: lBase,
        remotePrefix,
        localPrefix,
        entryUrl: rBase ? `${remotePrefix}/` : `${remoteOrigin}/`,
        fetchPatterns,
        matchesRemote,
        toLocal,
        toRemote,
    };
};

/** Whether a Content-Type header denotes an infinite Server-Sent Events stream. */
export const isEventStream = (contentType: string | null | undefined): boolean =>
    Boolean(contentType && /^text\/event-stream\b/i.test(contentType.trim()));

/** RFC 9110 §7.6.1 standard hop-by-hop headers. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

/** Strips standard RFC 9110 §7.6.1 hop-by-hop headers and headers nominated by `Connection`. */
export const stripHopByHopHeaders = <T extends string | string[] | undefined>(
    headers: Record<string, T>,
): Record<string, T> => {
    const dynamicDrop = new Set<string>();

    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== 'connection' || value === undefined) continue;
        const raw: string = Array.isArray(value) ? value.join(',') : String(value);

        for (const token of raw.split(',')) {
            const normalized = token.trim().toLowerCase();

            if (normalized) dynamicDrop.add(normalized);
        }
    }

    const result: Record<string, T> = {};

    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();

        if (HOP_BY_HOP.has(lower) || dynamicDrop.has(lower)) continue;
        result[name] = value;
    }

    return result;
};

/**
 * Reverse-proxy headers describing the stand to an SSR server (`--forwarded`): frameworks then build
 * absolute URLs, redirects, canonical/OG tags and OAuth callbacks for the stand, not for localhost.
 */
export const forwardedHeadersFor = (
    mapper: Pick<UrlMapper, 'remoteOrigin' | 'remoteBase'>,
): Record<string, string> => {
    const remote = new URL(mapper.remoteOrigin);
    const proto = remote.protocol.replace(/:$/, '');
    const port = remote.port || (proto === 'https' ? '443' : '80');

    return {
        'x-forwarded-host': remote.host,
        'x-forwarded-proto': proto,
        'x-forwarded-port': port,
        forwarded: `host="${remote.host}";proto=${proto}`,
        ...(mapper.remoteBase ? { 'x-forwarded-prefix': mapper.remoteBase } : {}),
    };
};

/**
 * Request headers for the local server: cookies of the stand's domain, Origin and Referer rewritten
 * to the local server. With `forwarded` (reverse-proxy mode) Origin and Referer stay the stand's, so
 * framework CSRF checks (Next.js Server Actions compare Origin with X-Forwarded-Host) stay consistent.
 */
export const toLocalHeaders = (
    headers: Record<string, string>,
    cookies: readonly { name: string; value: string }[],
    local: string,
    toLocal: (url: string) => string,
    forwarded?: Record<string, string>,
): Record<string, string> => {
    const cleaned = stripHopByHopHeaders(headers);
    const result = Object.fromEntries(
        Object.entries(cleaned).filter(([name]) => !DROP_REQUEST.has(name.toLowerCase())),
    );
    const origin = headers.Origin ?? headers.origin;
    const referer = headers.Referer ?? headers.referer;

    if (cookies.length) result.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (forwarded) {
        if (origin) result.origin = origin;
        if (referer) result.referer = referer;

        return { ...result, ...forwarded };
    }
    if (origin) result.origin = local;
    if (referer) result.referer = toLocal(referer);

    return result;
};

export const resolveHmrTarget = (
    url: string,
    hmrPorts: readonly number[],
): { wsUrl: string; origin: string } | null => {
    if (hmrPorts.length === 0) return null;
    try {
        const parsed = new URL(url);
        const port = Number(parsed.port);

        if (
            (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
            hmrPorts.includes(port)
        ) {
            return {
                wsUrl: `ws://${parsed.host}${parsed.pathname}${parsed.search}`,
                origin: `http://${parsed.host}`,
            };
        }
    } catch {
        return null;
    }

    return null;
};

export const startOverride = async ({
    page,
    remote,
    local,
    remoteBase = '',
    localBase = '',
    wsPrefixes = ['/_next/'],
    hmrPorts = [],
    quietPrefixes = ['/_next/static', '/__nextjs'],
    bypassPrefixes = [],
    ssePolicy = 'fail',
    forwardedHeaders = false,
    connect = connectCdp,
    fetchImpl = fetch,
    telemetry = false,
    logger = { request: debugLog.info, error: debugLog.error },
}: OverrideOptions): Promise<OverrideSession> => {
    const cdp = await connect(page.webSocketDebuggerUrl);
    const mapper = createUrlMapper({ remote, local, remoteBase, localBase });
    const forwarded = forwardedHeadersFor(mapper);
    let isLocalDownReported = false;

    const handle = async ({ requestId, request }: PausedRequest) => {
        const remotePath = new URL(request.url).pathname;

        if (
            !mapper.matchesRemote(request.url) ||
            bypassPrefixes.some((prefix) => remotePath.startsWith(prefix))
        ) {
            debugLog.debug(`continue ${request.method} ${request.url}`, {
                reason: mapper.matchesRemote(request.url) ? 'bypass' : 'other origin',
            });
            // The request is gone if the page navigated away meanwhile.
            await bestEffort(cdp.send('Fetch.continueRequest', { requestId }));

            return;
        }

        const url = mapper.toLocal(request.url);

        try {
            const cookies = await sendDecoded(
                cdp,
                'Network.getCookies',
                { urls: [request.url] },
                decodeCookies,
            );
            const body = request.postDataEntries
                ? Buffer.concat(
                      request.postDataEntries.map((e) => Buffer.from(e.bytes ?? '', 'base64')),
                  )
                : request.postData;
            const response = await fetchImpl(url, {
                method: request.method,
                headers: toLocalHeaders(
                    request.headers,
                    cookies,
                    mapper.localOrigin,
                    mapper.toLocal,
                    forwardedHeaders ? forwarded : undefined,
                ),
                ...(body === undefined
                    ? {}
                    : { body: typeof body === 'string' ? body : new Uint8Array(body) }),
                redirect: 'manual',
            });

            if (isEventStream(response.headers.get('content-type'))) {
                // Closing an endless stream we will not read: nothing to report if it is closed already.
                await bestEffort(response.body?.cancel());
                logger.error(
                    `SSE stream (text/event-stream) cannot be buffered by CDP Fetch: ${request.method} ${remotePath}. Use WebSocket HMR or --bypass ${remotePath}`,
                );
                if (ssePolicy === 'continue') {
                    await bestEffort(cdp.send('Fetch.continueRequest', { requestId }));

                    return;
                }
                await bestEffort(
                    cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }),
                );

                return;
            }

            const responseHeaders: { name: string; value: string }[] = [];

            response.headers.forEach((value, name) => {
                if (DROP_RESPONSE_HEADERS.has(name)) return;
                responseHeaders.push({
                    name,
                    value: name === 'location' ? mapper.toRemote(value) : value,
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

            const localPath = new URL(url).pathname;

            if (!quietPrefixes.some((prefix) => localPath.startsWith(prefix))) {
                logger.request(`${response.status} ${request.method} ${localPath}`);
            }
            isLocalDownReported = false;
        } catch (error) {
            const cause = error instanceof Error ? error.cause : undefined;
            const code =
                (typeof cause === 'object' && cause && 'code' in cause && String(cause.code)) ||
                errorMessage(error);

            if (code !== 'ECONNREFUSED') {
                logger.error(`FAIL ${request.method} ${url}: ${code}`);
            }
            if (code === 'ECONNREFUSED' && !isLocalDownReported) {
                isLocalDownReported = true;
                logger.error(`Local server ${mapper.localOrigin} does not respond`);
            }
            // Already answered or gone with the page: the error above is what matters.
            await bestEffort(
                cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }),
            );
        }
    };

    const sockets = new Map<number, WebSocket>();
    // A socket message for a page that navigated away has no receiver any more.
    const deliver = (sid: number, type: string, data = '', binary = false) =>
        bestEffort(
            cdp.send('Runtime.evaluate', {
                expression: `window.${RECEIVER}?.(${sid}, ${JSON.stringify(type)}, ${JSON.stringify(data)}, ${binary})`,
            }),
        );

    const onBinding = ({ name, payload }: BindingCall) => {
        if (name !== BINDING) return;

        // The binding is callable by any script in the page: treat the payload as untrusted.
        const message = decodeBridgeMessage(parseJson(payload));

        if (!message) return;

        const { sid, type, url, data, binary, protocols } = message;

        if (type === 'open' && url !== undefined) {
            const hmr = resolveHmrTarget(url, hmrPorts);

            // Only the stand's origin (mapped to local) and configured HMR ports: never an
            // arbitrary host the page asks for.
            if (!hmr && !mapper.matchesRemote(url)) {
                void deliver(sid, 'error').then(() => deliver(sid, 'close'));

                return;
            }

            const targetUrl = hmr ? hmr.wsUrl : mapper.toLocal(url).replace(/^http/, 'ws');
            const targetOrigin = hmr ? hmr.origin : mapper.localOrigin;
            debugLog.debug(`bridge socket #${sid} → ${targetUrl}`, { protocols });

            // Node's WebSocket (undici) takes headers in its second argument, unlike the DOM one.
            const socket = new WebSocket(targetUrl, {
                ...(protocols.length > 0 ? { protocols } : {}),
                headers: { origin: targetOrigin },
            });

            socket.binaryType = 'arraybuffer';
            socket.onopen = () => deliver(sid, 'open', socket.protocol);
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

    subscribe(cdp, 'Fetch.requestPaused', decodePausedRequest, (params) => void handle(params));
    subscribe(cdp, 'Runtime.bindingCalled', decodeBindingCall, onBinding);

    const detachTelemetry = telemetry
        ? attachTelemetry(cdp, telemetry === true ? {} : telemetry)
        : undefined;

    const shim = bridgeShim(mapper.remoteOrigin, wsPrefixes, hmrPorts);

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: BINDING });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });

    const check = await sendDecoded(
        cdp,
        'Runtime.evaluate',
        { expression: `new Function(${JSON.stringify(shim)}); 'ok'` },
        decodeEvaluateResult,
    );

    if (check.exception !== undefined) {
        throw new Error(`WebSocket bridge script: ${check.exception}`);
    }

    await cdp.send('Fetch.enable', {
        patterns: [...mapper.fetchPatterns],
    });

    const reload = async () => {
        await cdp.send('Page.reload', { ignoreCache: true });
    };

    const ensureOnTarget = async () => {
        if (mapper.matchesRemote(page.url)) {
            await reload();

            return;
        }
        await cdp.send('Page.navigate', { url: mapper.entryUrl });
    };

    await ensureOnTarget();

    void cdp.closed.then(() => {
        detachTelemetry?.();
        for (const socket of sockets.values()) socket.close();
        sockets.clear();
    });

    return { reload, close: () => cdp.close(), closed: cdp.closed };
};
