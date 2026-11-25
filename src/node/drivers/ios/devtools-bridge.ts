// Fixed-address Chrome DevTools bridge for iOS WKWebView (http://localhost:3300 on Windows & macOS).
// Accepts Chrome DevTools WebSocket frames (CDP), translates them to WebKit Inspector Protocol (WIP)
// for the connected iPhone, and translates responses/events back to CDP.

import { startDevtoolsHttpServer } from '../../devtools-frontend.ts';
import { frontendPath, type DevtoolsLink } from '../../devtools-link.ts';
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
    createExecutionContextTracker,
    translateCdpToWip,
    translateWipEventToCdp,
    translateWipResultToCdp,
} from './wip-cdp-bridge.ts';
import { createWebKitTargetRouter } from './webkit-targets.ts';

/**
 * Chrome DevTools frontend revision served for iOS (WebKit has no Chromium revision of its own).
 * Verified to exist on chrome-devtools-frontend.appspot.com (Chromium 157 era). Override with
 * `WEBVIEW_LENS_DEVTOOLS_REVISION` when a mirror or a newer frontend is needed.
 */
export const DEFAULT_IOS_FRONTEND_REVISION = '0985600c06a688b9c669e74afde7dacd5aaed047';

const defaultRevision = (): string =>
    process.env.WEBVIEW_LENS_DEVTOOLS_REVISION?.match(/^[0-9a-f]{40}$/)?.[0] ??
    DEFAULT_IOS_FRONTEND_REVISION;

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

/**
 * Single Chromium-only methods of shared domains (seen against iOS 26 WebKit), answered with the
 * empty result the DevTools UI expects instead of a "'…' was not found" error.
 */
const AUTO_ACK_RESULTS: Readonly<Record<string, object>> = {
    'Page.startScreencast': {},
    'Page.stopScreencast': {},
    'Page.screencastFrameAck': {},
    'CSS.getEnvironmentVariables': { environmentVariables: {} },
    'CSS.getLonghandProperties': { longhandProperties: [] },
    'CSS.trackComputedStyleUpdates': {},
    'CSS.trackComputedStyleUpdatesForNode': {},
    'CSS.takeComputedStyleUpdates': { nodeIds: [] },
};

const isAutoAckMethod = (method: string): boolean =>
    method in AUTO_ACK_RESULTS || AUTO_ACK_PREFIXES.some((prefix) => method.startsWith(prefix));

export interface ClientFrameResult {
    immediateResponse?: string;
    forward?: string;
}

export interface IosDevtoolsTranslator {
    fromClient(rawJson: string): ClientFrameResult;
    fromUpstream(rawJson: string): string | null;
    /** Builds a bridge-originated WIP command whose reply is swallowed (never reaches the UI). */
    internalCommand(method: string, params?: Record<string, unknown>): string;
}

/** Ids of bridge-originated commands; far above anything the DevTools frontend allocates. */
const INTERNAL_ID_BASE = 1_000_000_000;

/** Upper bound for bytes buffered from the DevTools client before frames are decoded. */
const MAX_CLIENT_BUFFER_BYTES = 32 * 1024 * 1024;

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
    const internalIds = new Set<number>();
    const contexts = createExecutionContextTracker();
    let nextInternalId = INTERNAL_ID_BASE;

    return {
        internalCommand(method: string, params: Record<string, unknown> = {}): string {
            nextInternalId += 1;
            internalIds.add(nextInternalId);

            return JSON.stringify({ id: nextInternalId, method, params });
        },
        fromClient(rawJson: string): ClientFrameResult {
            let msg: JsonRpcMessage;

            try {
                msg = JSON.parse(rawJson) as JsonRpcMessage;
            } catch {
                return {};
            }

            if (typeof msg.method !== 'string') return { forward: rawJson };

            if (isAutoAckMethod(msg.method) && msg.id !== undefined) {
                return {
                    immediateResponse: JSON.stringify({
                        id: msg.id,
                        result: AUTO_ACK_RESULTS[msg.method] ?? {},
                    }),
                };
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

            if (msg.id !== undefined && internalIds.delete(msg.id)) return null;

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
                contexts.observe(msg.method, msg.params);

                const translated = translateWipEventToCdp(msg.method, msg.params, {
                    executionContextId: contexts.mainContextId,
                });

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
    revision = defaultRevision(),
    log = console.error,
}: IosDevtoolsLinkOptions): DevtoolsLink => {
    const activeTargets = new Map<string, InspectableTarget>();

    return startDevtoolsHttpServer({
        port,
        label: 'iOS DevTools bridge',
        waitingPage: WAITING_PAGE,
        log,
        resolveRedirectPath: async () => {
            const target = await resolveTarget();

            if (!target || !target.debuggerUrl) return undefined;
            activeTargets.set(target.id, target);

            return frontendPath(target.id, port, revision);
        },
        onUpgrade: (request, socket, head) => {
            const key = request.headers['sec-websocket-key'];
            const pageId = request.url?.match(/^\/devtools\/page\/([^?]+)/)?.[1];
            const target = pageId ? activeTargets.get(pageId) : undefined;

            if (!key || !target?.debuggerUrl) {
                socket.destroy();

                return;
            }

            const upstream = new WebSocket(target.debuggerUrl);
            const translator = createIosDevtoolsTranslator();
            // iOS 12.2+: commands go through WebKit targets (Target.sendMessageToTarget).
            const router = createWebKitTargetRouter({
                sendUpstream: (raw) => {
                    if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
                },
                deliver: (raw) => {
                    const translated = translator.fromUpstream(raw);

                    if (translated && !socket.destroyed) socket.write(encodeWsFrame(translated));
                },
            });
            const assembler = createWsFrameAssembler();
            let buffer: Buffer = Buffer.from(head);
            let clientAccepted = false;

            const closeAll = () => {
                router.dispose();
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
                        if (forward && upstream.readyState === WebSocket.OPEN) router.send(forward);
                    }
                }
            };

            upstream.onopen = () => {
                socket.write(buildWebSocketAcceptResponse(key));
                clientAccepted = true;
                // Enable WebKit Console domain proactively so console.log appears in Chrome DevTools.
                router.send(translator.internalCommand('Console.enable'));
                if (buffer.length > 0) flushClientBuffer();
            };

            upstream.onmessage = ({ data }) => router.onUpstream(String(data));

            upstream.onclose = closeAll;
            upstream.onerror = closeAll;

            socket.on('data', (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > MAX_CLIENT_BUFFER_BYTES) {
                    if (clientAccepted) socket.write(encodeCloseFrame(1009, 'message too big'));
                    closeAll();

                    return;
                }
                if (clientAccepted) flushClientBuffer();
            });
            socket.on('error', closeAll);
            socket.on('close', closeAll);
        },
    });
};
