// Fixed-address Chrome DevTools bridge for iOS WKWebView (http://localhost:3300 on Windows & macOS).
// Accepts Chrome DevTools WebSocket frames (CDP), translates them to WebKit Inspector Protocol (WIP)
// for the connected iPhone, and translates responses/events back to CDP.

import http from 'node:http';
import type net from 'node:net';

import { frontendPath, stripCspMeta, type DevtoolsLink } from '../../devtools-link.ts';
import {
    buildWebSocketAcceptResponse,
    createWsFrameAssembler,
    decodeWsFrames,
    encodeCloseFrame,
    encodeWsFrame,
    WS_OPCODE_CLOSE,
    WS_OPCODE_PING,
    WS_OPCODE_PONG,
    WS_OPCODE_TEXT,
} from '../../ws-server.ts';
import type { InspectableTarget } from '../types.ts';
import {
    translateCdpToWip,
    translateWipEventToCdp,
    translateWipResultToCdp,
} from './wip-cdp-bridge.ts';

const FRONTEND_ORIGIN = 'https://chrome-devtools-frontend.appspot.com';
/** Known stable Chromium DevTools frontend revision compatible with core CDP domains. */
const DEFAULT_FRONTEND_REVISION = 'e6a1d0b34c3a4475a6f595284e83a6c8e0f10d5e';

/** Chromium-only CDP domains/methods that WebKit does not implement; auto-acked to keep UI clean. */
const AUTO_ACK_PREFIXES = [
    'Autofill.',
    'Audits.',
    'BackgroundService.',
    'Cast.',
    'Emulation.',
    'Overlay.',
    'Preload.',
    'ServiceWorker.',
    'Storage.',
    'Target.',
];

const isAutoAckMethod = (method: string): boolean =>
    AUTO_ACK_PREFIXES.some((prefix) => method.startsWith(prefix));

export interface ClientFrameResult {
    immediateResponse?: string;
    forward?: string;
}

export interface IosDevtoolsTranslator {
    fromClient(rawJson: string): ClientFrameResult;
    fromUpstream(rawJson: string): string | null;
}

interface JsonRpcMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
}

/** Stateful per-connection WIP ↔ CDP JSON-RPC frame translator. */
export const createIosDevtoolsTranslator = (): IosDevtoolsTranslator => {
    const pendingMethods = new Map<number, string>();

    return {
        fromClient(rawJson: string): ClientFrameResult {
            let msg: JsonRpcMessage;

            try {
                msg = JSON.parse(rawJson) as JsonRpcMessage;
            } catch {
                return {};
            }

            if (typeof msg.method !== 'string') return { forward: rawJson };

            if (isAutoAckMethod(msg.method) && msg.id !== undefined) {
                return { immediateResponse: JSON.stringify({ id: msg.id, result: {} }) };
            }

            if (msg.id !== undefined) pendingMethods.set(msg.id, msg.method);

            const translated = translateCdpToWip(msg.method, msg.params ?? {});

            return {
                forward: JSON.stringify({
                    ...(msg.id !== undefined ? { id: msg.id } : {}),
                    method: translated.method,
                    params: translated.params,
                }),
            };
        },
        fromUpstream(rawJson: string): string | null {
            let msg: JsonRpcMessage;

            try {
                msg = JSON.parse(rawJson) as JsonRpcMessage;
            } catch {
                return null;
            }

            if (msg.id !== undefined) {
                const originalMethod = pendingMethods.get(msg.id);

                pendingMethods.delete(msg.id);
                if (msg.error !== undefined) return rawJson;

                const translatedResult = originalMethod
                    ? translateWipResultToCdp(originalMethod, msg.result)
                    : msg.result;

                return JSON.stringify({ id: msg.id, result: translatedResult });
            }

            if (typeof msg.method === 'string') {
                const translated = translateWipEventToCdp(msg.method, msg.params);

                if (!translated) return null;

                return JSON.stringify({ method: translated.method, params: translated.params });
            }

            return rawJson;
        },
    };
};

const WAITING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>webview-lens · iOS DevTools</title>
<body style="font:16px system-ui;padding:24px">
<p>No inspectable iOS WKWebView page yet.</p>
<p>Enable <b>Settings → Safari → Advanced → Web Inspector</b> on iPhone and open your test app screen.</p>`;

interface FrontendFile {
    status: number;
    type: string;
    body: Buffer;
}

const frontendCache = new Map<string, FrontendFile>();

const loadFrontendFile = async (pathname: string): Promise<FrontendFile> => {
    const cached = frontendCache.get(pathname);

    if (cached) return cached;

    const response = await fetch(FRONTEND_ORIGIN + pathname);

    if (!response.ok) return { status: response.status, type: 'text/plain', body: Buffer.alloc(0) };

    const type = response.headers.get('content-type') ?? 'application/octet-stream';
    const raw = Buffer.from(await response.arrayBuffer());
    const body = type.includes('text/html') ? Buffer.from(stripCspMeta(raw.toString('utf8'))) : raw;
    const file = { status: 200, type, body };

    frontendCache.set(pathname, file);

    return file;
};

export interface IosDevtoolsLinkOptions {
    port: string | number;
    resolveTarget: () => Promise<InspectableTarget | undefined>;
    revision?: string;
    log?: (line: string) => void;
}

/**
 * Serves Chrome DevTools UI at `http://localhost:<port>` and bridges its CDP WebSocket to the
 * active iOS WKWebView's WebKit Inspector Protocol WebSocket.
 */
export const startIosDevtoolsLink = ({
    port,
    resolveTarget,
    revision = DEFAULT_FRONTEND_REVISION,
    log = console.error,
}: IosDevtoolsLinkOptions): DevtoolsLink => {
    const activeTargets = new Map<string, InspectableTarget>();

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');

        try {
            if (url.pathname.startsWith('/serve_rev/')) {
                const file = await loadFrontendFile(url.pathname);

                response.writeHead(file.status, { 'content-type': file.type });
                response.end(file.body);

                return;
            }

            const target = await resolveTarget();

            if (!target || !target.debuggerUrl) {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(WAITING_PAGE);

                return;
            }

            activeTargets.set(target.id, target);
            response.writeHead(302, {
                location: frontendPath(target.id, port, revision),
                'cache-control': 'no-store',
            });
            response.end();
        } catch (error) {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(
                `iOS DevTools unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    });

    server.on('upgrade', (request, socket: net.Socket, head) => {
        const key = request.headers['sec-websocket-key'];
        const pageId = request.url?.match(/^\/devtools\/page\/([^?]+)/)?.[1];
        const target = pageId ? activeTargets.get(pageId) : undefined;

        if (!key || !target?.debuggerUrl) {
            socket.destroy();

            return;
        }

        const upstream = new WebSocket(target.debuggerUrl);
        const translator = createIosDevtoolsTranslator();
        const assembler = createWsFrameAssembler();
        let buffer: Buffer = Buffer.from(head);
        let clientAccepted = false;

        const closeAll = () => {
            if (
                upstream.readyState === WebSocket.OPEN ||
                upstream.readyState === WebSocket.CONNECTING
            ) {
                upstream.close();
            }
            socket.destroy();
        };

        const flushClientBuffer = () => {
            const { frames, remainder } = decodeWsFrames(buffer);

            buffer = remainder;
            for (const frame of frames) {
                let message;

                try {
                    message = assembler.push(frame);
                } catch {
                    socket.write(encodeCloseFrame(1002, 'protocol error'));
                    closeAll();

                    return;
                }
                if (!message) continue;
                if (message.opcode === WS_OPCODE_CLOSE) {
                    socket.write(encodeCloseFrame(1000));
                    closeAll();

                    return;
                }
                if (message.opcode === WS_OPCODE_PING) {
                    socket.write(encodeWsFrame(message.payload, WS_OPCODE_PONG));
                    continue;
                }
                if (message.opcode === WS_OPCODE_TEXT) {
                    const { immediateResponse, forward } = translator.fromClient(
                        message.payload.toString('utf8'),
                    );

                    if (immediateResponse) socket.write(encodeWsFrame(immediateResponse));
                    if (forward && upstream.readyState === WebSocket.OPEN) upstream.send(forward);
                }
            }
        };

        upstream.onopen = () => {
            socket.write(buildWebSocketAcceptResponse(key));
            clientAccepted = true;
            // Enable WebKit Console domain proactively so console.log appears in Chrome DevTools.
            upstream.send(JSON.stringify({ id: 900_001, method: 'Console.enable', params: {} }));
            if (buffer.length > 0) flushClientBuffer();
        };

        upstream.onmessage = ({ data }) => {
            const translated = translator.fromUpstream(String(data));

            if (translated && !socket.destroyed) socket.write(encodeWsFrame(translated));
        };

        upstream.onclose = closeAll;
        upstream.onerror = closeAll;

        socket.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (clientAccepted) flushClientBuffer();
        });
        socket.on('error', closeAll);
        socket.on('close', closeAll);
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
        log(`iOS DevTools bridge on :${port} did not start: ${error.code ?? error.message}`);
    });
    server.listen(Number(port), 'localhost');

    return { url: `http://localhost:${port}`, close: () => server.close() };
};
