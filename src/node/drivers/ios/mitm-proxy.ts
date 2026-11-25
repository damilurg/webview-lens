// Selective HTTPS MITM proxy for iOS WKWebView `webview-lens dev`.
// Intercepts ONLY the configured --remote hostname (forwarding HTTP and native WebSocket HMR to
// your local dev server) while tunneling all other domains untouched via raw TCP CONNECT.

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

import { errorMessage } from '../../../shared/utils.ts';
import { connectAndPipe } from '../../fs-utils.ts';
import {
    createUrlMapper,
    DROP_RESPONSE_HEADERS,
    forwardedHeadersFor,
    stripHopByHopHeaders,
    type OverrideLogger,
    type UrlMapper,
} from '../../override.ts';
import { buildIosMobileConfig, type CertPair, ensureRootCa, generateLeafCert } from './certs.ts';

const DROP_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'accept-encoding',
]);

export interface ConnectTarget {
    host: string;
    port: number;
}

/** Parses an HTTP CONNECT authority (`host:port` or `[::1]:443`). */
export const parseConnectTarget = (authority: string): ConnectTarget | null => {
    const trimmed = authority.trim();

    if (!trimmed) return null;

    if (trimmed.startsWith('[')) {
        const match = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);

        if (!match?.[1]) return null;

        return { host: match[1], port: match[2] ? Number(match[2]) : 443 };
    }

    const idx = trimmed.lastIndexOf(':');

    if (idx === -1) return { host: trimmed, port: 443 };

    const host = trimmed.slice(0, idx);
    const port = Number(trimmed.slice(idx + 1));

    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;

    return { host, port };
};

const PRIVATE_NETWORKS = (() => {
    const list = new net.BlockList();

    for (const [prefix, bits] of [
        ['127.0.0.0', 8],
        ['10.0.0.0', 8],
        ['172.16.0.0', 12],
        ['192.168.0.0', 16],
        ['169.254.0.0', 16],
        ['100.64.0.0', 10],
    ] as const) {
        list.addSubnet(prefix, bits, 'ipv4');
    }
    list.addAddress('::1', 'ipv6');
    list.addSubnet('fe80::', 10, 'ipv6');
    list.addSubnet('fc00::', 7, 'ipv6');

    return list;
})();

/**
 * Whether a client address is loopback, private (RFC 1918 / RFC 4193), link-local or CGNAT
 * (RFC 6598). The proxy listens on all interfaces; this keeps it from being an open proxy.
 */
export const isPrivateNetworkAddress = (address: string | undefined): boolean => {
    if (!address) return false;

    const family = net.isIP(address);

    if (family === 0) return false;

    return PRIVATE_NETWORKS.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Selective MITM rule: intercept only exact target host (case-insensitive). */
export const shouldInterceptHost = (host: string, targetHost: string): boolean =>
    host.toLowerCase() === targetHost.toLowerCase();

/** Classifies TLS handshake errors into actionable iOS certificate/pinning diagnostics. */
export const classifyTlsError = (error: Error): string => {
    const msg = error.message || String(error);

    if (
        /unknown[_\s]ca|certificate[_\s]unknown|bad[_\s]certificate|alert.*certificate/i.test(msg)
    ) {
        return `iOS rejected the proxy certificate (${msg}). Install the profile from /webview-lens.mobileconfig and enable it in Settings → General → About → Certificate Trust Settings, or disable SSL Pinning in the test build.`;
    }
    if (/ECONNRESET|socket hang up/i.test(msg)) {
        return `iOS closed the TLS handshake (${msg}). Check Certificate Trust Settings and verify SSL Pinning is disabled in the test build.`;
    }

    return `TLS handshake error: ${msg}`;
};

/**
 * "fetch failed" with its cause (ECONNREFUSED, CERT_HAS_EXPIRED, …) and, for certificate errors on
 * bypassed requests to a stand with a private CA, the fix: Node does not use the system keychain.
 */
export const describeFetchError = (error: unknown): string => {
    const cause = error instanceof Error ? error.cause : undefined;
    const code =
        typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
    const message = code ? `${errorMessage(error)} (${code})` : errorMessage(error);

    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) {
        return `${message}: the stand's certificate is not trusted by Node; start webview-lens with NODE_EXTRA_CA_CERTS=/path/to/stand-ca.pem`;
    }

    return message;
};

export interface DecryptedRequestInput {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body?: Uint8Array;
    mapper: UrlMapper;
    bypassPrefixes?: readonly string[];
    /** Reverse-proxy mode for SSR (see `OverrideOptions.forwardedHeaders`). */
    forwardedHeaders?: boolean;
    fetchImpl?: typeof fetch;
}

export interface DecryptedResponseOutput {
    status: number;
    headers: Record<string, string>;
    setCookies: string[];
    body: Buffer;
    targetUrl: string;
    bypassed: boolean;
}

/** Handles one decrypted HTTPS request: proxies to local server or bypasses to real stand. */
export const handleDecryptedRequest = async ({
    method,
    url,
    headers,
    body,
    mapper,
    bypassPrefixes = [],
    forwardedHeaders = false,
    fetchImpl = fetch,
}: DecryptedRequestInput): Promise<DecryptedResponseOutput> => {
    const remoteUrl = `${mapper.remoteOrigin}${url.startsWith('/') ? url : `/${url}`}`;
    const remotePath = new URL(remoteUrl).pathname;
    const bypassed =
        !mapper.matchesRemote(remoteUrl) ||
        bypassPrefixes.some((prefix) => remotePath.startsWith(prefix));
    const targetUrl = bypassed ? remoteUrl : mapper.toLocal(remoteUrl);

    const cleanedHeaders = stripHopByHopHeaders(headers);
    const outHeaders: Record<string, string> = {};

    for (const [rawName, rawValue] of Object.entries(cleanedHeaders)) {
        if (rawValue === undefined) continue;
        const lower = rawName.toLowerCase();

        if (DROP_REQUEST_HEADERS.has(lower)) continue;

        const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;

        const rewrite = !bypassed && !forwardedHeaders;

        if (rewrite && lower === 'origin') {
            outHeaders.origin = mapper.localOrigin;
            continue;
        }
        if (rewrite && lower === 'referer') {
            outHeaders.referer = mapper.toLocal(value);
            continue;
        }
        outHeaders[lower] = value;
    }
    if (!bypassed && forwardedHeaders) Object.assign(outHeaders, forwardedHeadersFor(mapper));

    const init: RequestInit = {
        method,
        headers: outHeaders,
        redirect: 'manual',
    };

    if (body && body.byteLength > 0 && method !== 'GET' && method !== 'HEAD') {
        init.body = body as unknown as BodyInit;
    }

    const response = await fetchImpl(targetUrl, init);
    const responseHeaders: Record<string, string> = {};

    response.headers.forEach((value, name) => {
        if (DROP_RESPONSE_HEADERS.has(name)) return;
        responseHeaders[name] = !bypassed && name === 'location' ? mapper.toRemote(value) : value;
    });

    const setCookies = response.headers.getSetCookie();
    const responseBody = Buffer.from(await response.arrayBuffer());

    return {
        status: response.status,
        headers: responseHeaders,
        setCookies,
        body: responseBody,
        targetUrl,
        bypassed,
    };
};

interface UpgradeRequestLike {
    method?: string | undefined;
    url?: string | undefined;
    headers: Record<string, string | string[] | undefined>;
}

/** Builds a raw HTTP/1.1 WebSocket upgrade handshake targeting the local dev server. */
export const buildWsUpgradeHandshake = (request: UpgradeRequestLike, mapper: UrlMapper): string => {
    const remoteUrl = `${mapper.remoteOrigin}${request.url ?? '/'}`;
    const localUrl = new URL(mapper.toLocal(remoteUrl));
    const localPath = `${localUrl.pathname}${localUrl.search}`;
    const headers: string[] = [`host: ${localUrl.host}`];

    for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();

        if (lower === 'host') continue;
        if (lower === 'origin') {
            headers.push(`origin: ${mapper.localOrigin}`);
            continue;
        }
        headers.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }

    return [`${request.method ?? 'GET'} ${localPath} HTTP/1.1`, ...headers, '', ''].join('\r\n');
};

/** Returns non-internal IPv4 LAN addresses of this machine for iPhone Wi-Fi Proxy setup. */
export const detectLanAddresses = (): string[] => {
    const result: string[] = [];

    for (const entries of Object.values(os.networkInterfaces())) {
        for (const info of entries ?? []) {
            if (info.family === 'IPv4' && !info.internal) result.push(info.address);
        }
    }

    return result;
};

/** Host answered by the proxy itself: it only opens when the iPhone really uses the proxy. */
export const PROXY_CHECK_HOST = 'webview-lens.check';

/** Path answered inside the intercepted TLS session: it only opens when the CA is trusted. */
export const INTERCEPT_CHECK_PATH = '/__webview-lens/ok';

const page = (title: string, body: string): string => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webview-lens · ${title}</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:32px auto;padding:0 16px">${body}`;

const certLandingPage = (hostHint: string, proxyPort: number, targetOrigin: string): string =>
    page(
        'iOS setup',
        `<h1>webview-lens iOS setup</h1>
<p>Open this page as <b>http://</b>${hostHint}:${proxyPort}/ (not https: the proxy port speaks plain HTTP).</p>
<p><a href="/webview-lens.mobileconfig" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:8px">Download iOS Profile (.mobileconfig)</a></p>
<ol>
  <li>Tap <b>Download iOS Profile</b> in Safari and allow it.</li>
  <li>Open <b>Settings → General → VPN &amp; Device Management</b> and install <i>webview-lens Local CA</i>.</li>
  <li>Open <b>Settings → General → About → Certificate Trust Settings</b> and enable full trust for <i>webview-lens Local CA</i>.</li>
  <li>In <b>Settings → Wi-Fi → (i) → Configure Proxy → Manual</b>, set Server <code>${hostHint}</code> and Port <code>${proxyPort}</code>.</li>
  <li>Check the proxy: <a href="http://${PROXY_CHECK_HOST}/">http://${PROXY_CHECK_HOST}/</a> must say <b>Proxy: OK</b>.</li>
  <li>Check the CA and interception: <a href="${targetOrigin}${INTERCEPT_CHECK_PATH}">${targetOrigin}${INTERCEPT_CHECK_PATH}</a> must say <b>Interception: OK</b>.</li>
</ol>
<p>When you are done, set the Wi-Fi proxy back to <b>Off</b>: without this Mac running, the iPhone has no internet through it.</p>
<p><small>Raw PEM certificate: <a href="/ca.cer">/ca.cer</a></small></p>`,
    );

export interface IosMitmProxyOptions {
    /** Stand origin to intercept, e.g. `https://stand.example.com`. */
    remote: string;
    /** Local dev server URL, e.g. `http://localhost:3000`. */
    local: string;
    remoteBase?: string;
    localBase?: string;
    /** Proxy listening port (default: 8888). */
    port?: number;
    /** Listening host (default: `0.0.0.0` so iPhone on Wi-Fi can reach it). */
    host?: string;
    /**
     * Which client addresses may use the proxy. Default: loopback and private networks only
     * (`isPrivateNetworkAddress`), so a public interface does not expose an open proxy.
     */
    allowClient?: (address: string | undefined) => boolean;
    bypassPrefixes?: readonly string[];
    quietPrefixes?: readonly string[];
    /** Reverse-proxy mode for SSR (see `OverrideOptions.forwardedHeaders`). */
    forwardedHeaders?: boolean;
    ca?: CertPair;
    certDir?: string;
    fetchImpl?: typeof fetch;
    logger?: OverrideLogger;
}

export interface IosMitmProxy {
    readonly port: number;
    readonly ca: CertPair;
    readonly targetHost: string;
    close(): Promise<void>;
}

/** Forwards an absolute-form plain HTTP proxy request (`GET http://host/path`) as is. */
const forwardPlainHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    let target: URL;

    try {
        target = new URL(req.url ?? '');
    } catch {
        res.writeHead(400).end();

        return;
    }

    const headers = stripHopByHopHeaders(req.headers);

    headers.host = target.host;

    const upstream = http.request(
        {
            hostname: target.hostname.replace(/^\[|\]$/g, ''),
            port: Number(target.port) || 80,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers,
        },
        (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHopHeaders(upstreamRes.headers));
            upstreamRes.pipe(res);
        },
    );

    upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
    });
    req.pipe(upstream);
};

const readBody = async (req: http.IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    return Buffer.concat(chunks);
};

/**
 * Starts the selective HTTPS MITM proxy for iOS `webview-lens dev`.
 * Also serves the Root CA profile at `/webview-lens.mobileconfig` and `/ca.cer`.
 */
export const startIosMitmProxy = async ({
    remote,
    local,
    remoteBase = '',
    localBase = '',
    port = 8888,
    host = '0.0.0.0',
    allowClient = isPrivateNetworkAddress,
    bypassPrefixes = [],
    quietPrefixes = [],
    forwardedHeaders = false,
    ca,
    certDir,
    fetchImpl = fetch,
    logger = { request: console.log, error: console.error },
}: IosMitmProxyOptions): Promise<IosMitmProxy> => {
    const mapper = createUrlMapper({ remote, local, remoteBase, localBase });
    const targetHost = new URL(mapper.remoteOrigin).hostname;
    const localUrl = new URL(mapper.localOrigin);
    const rootCa = ca ?? ensureRootCa(certDir);
    const leafCert = generateLeafCert(targetHost, rootCa);
    const mobileConfig = buildIosMobileConfig(rootCa.certPem);

    // Internal HTTP server receiving decrypted TLS sockets for `targetHost`.
    const decryptedServer = http.createServer(async (req, res) => {
        if (req.url === INTERCEPT_CHECK_PATH) {
            logger.request(`interception check OK for ${targetHost}`);
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(
                page(
                    'interception check',
                    `<h1>Interception: OK</h1><p>The webview-lens CA is trusted and requests to <b>${targetHost}</b> are served from <code>${mapper.localOrigin}</code>. Open <a href="${mapper.entryUrl}">${mapper.entryUrl}</a>.</p>`,
                ),
            );

            return;
        }
        try {
            const body = await readBody(req);
            const result = await handleDecryptedRequest({
                method: req.method ?? 'GET',
                url: req.url ?? '/',
                headers: req.headers,
                body,
                mapper,
                bypassPrefixes,
                forwardedHeaders,
                fetchImpl,
            });

            res.statusCode = result.status;
            for (const [name, value] of Object.entries(result.headers)) {
                res.setHeader(name, value);
            }
            if (result.setCookies.length > 0) {
                res.setHeader('set-cookie', result.setCookies);
            }
            res.end(result.body);

            const reqPath = new URL(result.targetUrl).pathname;

            if (!quietPrefixes.some((prefix) => reqPath.startsWith(prefix))) {
                logger.request(
                    `${result.status} ${req.method ?? 'GET'} ${reqPath}${result.bypassed ? ' (bypass)' : ''}`,
                );
            }
        } catch (error) {
            logger.error(
                `MITM FAIL ${req.method ?? 'GET'} ${req.url ?? '/'}: ${describeFetchError(error)}`,
            );
            res.statusCode = 502;
            res.end('webview-lens local proxy error');
        }
    });

    // Native WebSocket HMR tunneling over the decrypted HTTPS connection.
    decryptedServer.on('upgrade', (req, clientSocket, head) => {
        const isHttps = localUrl.protocol === 'https:';
        const localPort = Number(localUrl.port) || (isHttps ? 443 : 80);
        const localHost = localUrl.hostname.replace(/^\[|\]$/g, '');
        // Local https dev servers (Vite/Angular `--https`) use self-signed certs: trust them on
        // loopback only.
        const secure = isHttps
            ? {
                  servername: net.isIP(localHost) ? undefined : localHost,
                  rejectUnauthorized: !LOOPBACK_HOSTS.has(localUrl.hostname),
              }
            : undefined;

        connectAndPipe(
            localPort,
            localHost,
            clientSocket as net.Socket,
            (upstream) => {
                upstream.write(buildWsUpgradeHandshake(req, mapper));
                if (head.length > 0) upstream.write(head);
            },
            secure,
        );
    });

    // Outer HTTP proxy + CA download server.
    const proxyServer = http.createServer((req, res) => {
        // With the iPhone's Wi-Fi proxy set, plain http:// traffic arrives in absolute form
        // (`GET http://host/path`): forward it instead of answering with the landing page.
        if (/^http:\/\//i.test(req.url ?? '')) {
            if (new URL(req.url ?? '').hostname === PROXY_CHECK_HOST) {
                logger.request(`proxy check OK from ${req.socket.remoteAddress ?? 'unknown'}`);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(
                    page(
                        'proxy check',
                        `<h1>Proxy: OK</h1><p>This iPhone sends its traffic through webview-lens. Next: <a href="${mapper.remoteOrigin}${INTERCEPT_CHECK_PATH}">check the CA and interception</a>.</p>`,
                    ),
                );

                return;
            }
            forwardPlainHttp(req, res);

            return;
        }

        const urlPath = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
            .pathname;

        if (urlPath === '/webview-lens.mobileconfig') {
            res.writeHead(200, {
                'content-type': 'application/x-apple-aspen-config',
                'content-disposition': 'attachment; filename="webview-lens.mobileconfig"',
            });
            res.end(mobileConfig);

            return;
        }
        if (urlPath === '/ca.cer') {
            res.writeHead(200, {
                'content-type': 'application/x-x509-ca-cert',
                'content-disposition': 'attachment; filename="webview-lens-ca.cer"',
            });
            res.end(rootCa.certPem);

            return;
        }

        const hostHint = detectLanAddresses()[0] ?? 'localhost';

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(certLandingPage(hostHint, port, mapper.remoteOrigin));
    });

    proxyServer.on('connection', (socket: net.Socket) => {
        if (allowClient(socket.remoteAddress)) return;
        logger.error(
            `Proxy refused client ${socket.remoteAddress ?? 'unknown'} (not a private network)`,
        );
        socket.destroy();
    });

    proxyServer.on('connect', (req, clientSocket, head) => {
        const target = parseConnectTarget(req.url ?? '');

        if (!target) {
            clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');

            return;
        }

        if (!shouldInterceptHost(target.host, targetHost)) {
            connectAndPipe(target.port, target.host, clientSocket as net.Socket, (upstream) => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) upstream.write(head);
            });

            return;
        }

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        const tlsSocket = new tls.TLSSocket(clientSocket, {
            isServer: true,
            key: leafCert.keyPem,
            cert: leafCert.certPem,
        });

        tlsSocket.on('error', (error) => {
            logger.error(classifyTlsError(error));
            tlsSocket.destroy();
        });

        decryptedServer.emit('connection', tlsSocket);
        if (head.length > 0) tlsSocket.unshift(head);
    });

    await new Promise<void>((resolve, reject) => {
        proxyServer.once('error', reject);
        proxyServer.listen(port, host, () => resolve());
    });

    const address = proxyServer.address();
    const listeningPort = address && typeof address !== 'string' ? address.port : port;

    return {
        port: listeningPort,
        ca: rootCa,
        targetHost,
        close: () =>
            new Promise<void>((resolve) => {
                decryptedServer.close();
                decryptedServer.closeAllConnections();
                proxyServer.close(() => resolve());
                // Keep-alive and tunneled sockets would otherwise hold close() open indefinitely.
                proxyServer.closeAllConnections();
            }),
    };
};
