// A minimal Chrome DevTools Protocol client over the global WebSocket (Node 22.4+).

import { isRecord } from '../shared/utils.ts';
import { createWebKitTargetRouter, type WebKitTargetRouter } from './drivers/ios/webkit-targets.ts';

export interface DevtoolsPage {
    id: string;
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
    devtoolsFrontendUrl?: string;
}

export type PagePredicate = (page: DevtoolsPage) => boolean;

const isDevtoolsPage = (value: unknown): value is DevtoolsPage =>
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.url === 'string' &&
    typeof value.webSocketDebuggerUrl === 'string';

/** A half-open forward (socket accepted, nothing answers) must not stall polling loops forever. */
const HTTP_TIMEOUT_MS = 5000;

/** Pages on the DevTools port; null when the port does not answer (no forward, or a stale socket). */
export const listPages = async (port: string | number): Promise<DevtoolsPage[] | null> => {
    try {
        const response = await fetch(`http://localhost:${port}/json/list`, {
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });

        if (!response.ok) return null;

        const data: unknown = await response.json();

        return Array.isArray(data) ? data.filter(isDevtoolsPage) : null;
    } catch {
        return null;
    }
};

/** `/json/version`: browser, User-Agent, WebKit-Version. Empty object when unavailable. */
export const getVersion = async (port: string | number): Promise<Record<string, unknown>> => {
    try {
        const response = await fetch(`http://localhost:${port}/json/version`, {
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        const data: unknown = await response.json();

        return isRecord(data) ? data : {};
    } catch {
        return {};
    }
};

export interface Cdp {
    /** Resolves with the command result, rejects with the protocol error. */
    send<T = unknown>(method: string, params?: object): Promise<T>;
    /** Subscribes to an event; returns the unsubscribe function. */
    on<T = unknown>(method: string, listener: (params: T) => void): () => void;
    once<T = unknown>(method: string): Promise<T>;
    close(): void;
    /** Settles when the socket closes (page closed, app restarted). */
    closed: Promise<void>;
}

interface Message {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message: string };
}

export interface ConnectCdpOptions {
    /**
     * WebKit page sockets (iOS 12.2+): route commands through `Target.sendMessageToTarget` and
     * unwrap `Target.dispatchMessageFromTarget`. Falls back to direct messages on older iOS.
     */
    webkitTargets?: boolean;
}

export const connectCdp = async (
    webSocketDebuggerUrl: string,
    { webkitTargets = false }: ConnectCdpOptions = {},
): Promise<Cdp> => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const listeners = new Map<string, Set<(params: unknown) => void>>();
    let nextId = 0;

    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () =>
            reject(
                new Error(
                    'Cannot connect to DevTools: another debugger may hold the page (close chrome://inspect for it)',
                ),
            );
    });

    let router: WebKitTargetRouter | undefined;

    const closed = new Promise<void>((resolve) => {
        ws.onclose = () => {
            router?.dispose();
            for (const { reject } of pending.values())
                reject(new Error('DevTools connection closed'));
            pending.clear();
            resolve();
        };
    });

    const handleMessage = (raw: string) => {
        let message: Message;

        try {
            message = JSON.parse(raw) as Message;
        } catch {
            // A malformed frame must not crash the process (listener errors surface as uncaught).
            return;
        }

        if (message.id !== undefined) {
            const call = pending.get(message.id);

            pending.delete(message.id);
            if (message.error) {
                call?.reject(new Error(message.error.message));

                return;
            }
            call?.resolve(message.result);

            return;
        }
        if (!message.method) return;
        for (const listener of listeners.get(message.method) ?? []) {
            try {
                listener(message.params);
            } catch (error) {
                console.error(`CDP listener for ${message.method} failed:`, error);
            }
        }
    };

    router = webkitTargets
        ? createWebKitTargetRouter({ sendUpstream: (raw) => ws.send(raw), deliver: handleMessage })
        : undefined;
    ws.onmessage = ({ data }) => {
        if (router) {
            router.onUpstream(String(data));

            return;
        }
        handleMessage(String(data));
    };

    const on = <T>(method: string, listener: (params: T) => void) => {
        const set = listeners.get(method) ?? new Set();
        // Events carry whatever the protocol defines for `method`; the caller names the type.
        const untyped = listener as (params: unknown) => void;

        set.add(untyped);
        listeners.set(method, set);

        return () => set.delete(untyped);
    };

    return {
        send: <T>(method: string, params: object = {}) =>
            new Promise<T>((resolve, reject) => {
                if (ws.readyState !== WebSocket.OPEN) {
                    reject(new Error('DevTools connection closed'));

                    return;
                }
                nextId += 1;
                pending.set(nextId, { resolve: resolve as (v: unknown) => void, reject });
                const raw = JSON.stringify({ id: nextId, method, params });

                if (router) {
                    router.send(raw);

                    return;
                }
                ws.send(raw);
            }),
        on,
        once: <T>(method: string) =>
            new Promise<T>((resolve) => {
                const off = on<T>(method, (params) => {
                    off();
                    resolve(params);
                });
            }),
        close: () => {
            router?.dispose();
            ws.close();
        },
        closed,
    };
};

/** A WebKit Inspector page socket (iOS) as a CDP-shaped transport, with target routing. */
export const connectWebKitInspector = (webSocketDebuggerUrl: string): Promise<Cdp> =>
    connectCdp(webSocketDebuggerUrl, { webkitTargets: true });
