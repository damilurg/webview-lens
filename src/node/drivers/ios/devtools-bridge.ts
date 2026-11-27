// Fixed-address Chrome DevTools bridge for iOS WKWebView (http://localhost:3300 on Windows & macOS).
// Accepts Chrome DevTools WebSocket frames (CDP), translates them to WebKit Inspector Protocol (WIP)
// for the connected iPhone, and translates responses/events back to CDP.

import { parseJson, rec, str } from '../../../shared/decode.ts';
import { startDevtoolsHttpServer } from '../../devtools-frontend.ts';
import { frontendPath, type DevtoolsLink } from '../../devtools-link.ts';
import { decodeRpcMessage } from '../../protocol.ts';
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
import { createLogger } from '../../logger.ts';

// Silent unless logging is configured (--verbose); callers pass their own callbacks to show it.
const bridgeLog = createLogger('ios-devtools');

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

/** Comments and whitespace before the last statement's code. */
const LEADING_COMMENTS = /^(?:\s+|\/\/.*|\/\*[\s\S]*?\*\/)+/;
const STATEMENT_START = /^(const|let|var|function|class|if|for|while|do|try|switch|throw|return)\b/;

/**
 * Where the last top-level statement starts (after the last `;` outside strings, comments, template
 * literals and brackets), or -1 for a single statement.
 */
const lastStatementStart = (code: string): number => {
    let depth = 0;
    let quote = '';
    let last = -1;

    for (let i = 0; i < code.length; i += 1) {
        const ch = code[i];

        if (quote) {
            if (ch === '\\') i += 1;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && code[i + 1] === '/') {
            const end = code.indexOf('\n', i);

            i = end === -1 ? code.length : end;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            const end = code.indexOf('*/', i + 2);

            i = end === -1 ? code.length : end + 1;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
        if (ch === ';' && depth === 0) last = i;
    }

    return last;
};

/**
 * Chrome's Console runs `await fetch(…)` at the top level through `replMode`, which WebKit lacks
 * (it answered SyntaxError on the test iPhone). Wrapped in an async function, the command becomes a
 * promise the bridge then awaits; its value is the last statement's, as in Chrome
 * (`const r = await fetch('/'); r.status` gives the status). Declarations stay local to the command.
 */
export const wrapTopLevelAwait = (expression: string): string => {
    const body = expression.trim().replace(/;+$/, '');
    const split = lastStatementStart(body);
    const head = split === -1 ? '' : body.slice(0, split + 1);
    const tail = body.slice(split + 1).trim();

    const code = tail.replace(LEADING_COMMENTS, '');

    if (!code || STATEMENT_START.test(code)) {
        return `(async () => { ${body}\n})()`;
    }

    // On its own lines, so a trailing `// comment` cannot swallow the closing parenthesis.
    return `(async () => { ${head} return (\n${tail}\n); })()`;
};

const usesAwait = (expression: unknown): expression is string =>
    typeof expression === 'string' && /\bawait\b/.test(expression);

export interface IosDevtoolsTranslatorOptions {
    /** Sends a bridge-originated frame to the page (the await step of a Console command). */
    sendUpstream?: (rawJson: string) => void;
}

/** Stateful per-connection WIP ↔ CDP JSON-RPC frame translator. */
export const createIosDevtoolsTranslator = ({
    sendUpstream,
}: IosDevtoolsTranslatorOptions = {}): IosDevtoolsTranslator => {
    const pendingMethods = new Map<number, string>();
    const internalIds = new Set<number>();
    /** Console commands sent wrapped, by their client id. */
    const awaitingPromise = new Set<number>();
    /** The bridge's Runtime.awaitPromise id → the Console command it answers. */
    const awaitFor = new Map<number, number>();
    const contexts = createExecutionContextTracker();
    let nextInternalId = INTERNAL_ID_BASE;

    return {
        internalCommand(method: string, params: Record<string, unknown> = {}): string {
            nextInternalId += 1;
            internalIds.add(nextInternalId);

            return JSON.stringify({ id: nextInternalId, method, params });
        },
        fromClient(rawJson: string): ClientFrameResult {
            const msg = decodeRpcMessage(parseJson(rawJson));

            if (!msg) return {};

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
            bridgeLog.debug(`DevTools → page ${msg.method}`, { id: msg.id });

            const params = msg.params ?? {};
            const wrap =
                sendUpstream !== undefined &&
                msg.method === 'Runtime.evaluate' &&
                msg.id !== undefined &&
                (params.replMode === true || params.awaitPromise === true) &&
                usesAwait(params.expression);

            if (wrap && msg.id !== undefined) awaitingPromise.add(msg.id);

            const translated = translateCdpToWip(
                msg.method,
                wrap && typeof params.expression === 'string'
                    ? { ...params, expression: wrapTopLevelAwait(params.expression) }
                    : params,
            );

            return {
                forward: JSON.stringify({
                    ...(msg.id !== undefined ? { id: msg.id } : {}),
                    method: translated.method,
                    params: translated.params,
                }),
            };
        },
        fromUpstream(rawJson: string): string | null {
            const msg = decodeRpcMessage(parseJson(rawJson));

            if (!msg) return null;

            const awaited = msg.id !== undefined ? awaitFor.get(msg.id) : undefined;

            if (msg.id !== undefined && awaited !== undefined) {
                awaitFor.delete(msg.id);

                return JSON.stringify(
                    msg.error !== undefined
                        ? { id: awaited, error: msg.error }
                        : {
                              id: awaited,
                              result: translateWipResultToCdp('Runtime.awaitPromise', msg.result),
                          },
                );
            }

            if (msg.id !== undefined && internalIds.delete(msg.id)) return null;

            // A wrapped Console command answered with its promise: await it, reply when it settles.
            if (msg.id !== undefined && awaitingPromise.delete(msg.id) && sendUpstream) {
                const result = rec(msg.result);
                const promiseObjectId = str(rec(result?.result)?.objectId);

                if (msg.error === undefined && result?.wasThrown !== true && promiseObjectId) {
                    pendingMethods.delete(msg.id);
                    nextInternalId += 1;
                    awaitFor.set(nextInternalId, msg.id);
                    sendUpstream(
                        JSON.stringify({
                            id: nextInternalId,
                            method: 'Runtime.awaitPromise',
                            params: {
                                promiseObjectId,
                                returnByValue: false,
                                generatePreview: true,
                                saveResult: true,
                            },
                        }),
                    );

                    return null;
                }
            }

            if (msg.id !== undefined) {
                const originalMethod = pendingMethods.get(msg.id);

                pendingMethods.delete(msg.id);
                if (msg.error !== undefined) {
                    bridgeLog.debug(`page → DevTools error for ${originalMethod ?? '?'}`, {
                        error: msg.error,
                    });

                    return rawJson;
                }

                const translatedResult = originalMethod
                    ? translateWipResultToCdp(originalMethod, msg.result)
                    : msg.result;

                return JSON.stringify({ id: msg.id, result: translatedResult });
            }

            if (typeof msg.method === 'string') {
                contexts.observe(msg.method, msg.params);
                bridgeLog.debug(
                    `page event ${msg.method}`,
                    msg.method.startsWith('Runtime.') ? { params: msg.params } : {},
                );

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
    log = bridgeLog.warn,
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
            const translator = createIosDevtoolsTranslator({
                sendUpstream: (raw) => {
                    if (upstream.readyState === WebSocket.OPEN) router.send(raw);
                },
            });
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
