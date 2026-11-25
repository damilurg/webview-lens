// A minimal Chrome DevTools Protocol client over the global WebSocket (Node 22.4+).

import { isRecord } from '../shared/utils.ts';
import { createLogger } from './logger.ts';

const log = createLogger('cdp');

export interface DevtoolsPage {
    id: string;
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
    devtoolsFrontendUrl?: string;
    /** Android WebView: JSON with `attached` (on screen), `visible`, size and position. */
    description?: string;
}

export type PagePredicate = (page: DevtoolsPage) => boolean;

/** Whether an Android WebView page is the one on screen (`"attached": true` in its description). */
export const isPageOnScreen = (page: Pick<DevtoolsPage, 'description'>): boolean => {
    try {
        const info: unknown = JSON.parse(page.description ?? '');

        return isRecord(info) && info.attached === true;
    } catch {
        return false;
    }
};

/**
 * The page to work with among those matching `predicate`: the one on screen first. An app keeps
 * WebViews of screens below the current one alive (and debuggable), all on the same URL.
 */
export const pickPage = (
    pages: readonly DevtoolsPage[] | null | undefined,
    predicate: PagePredicate,
): DevtoolsPage | undefined => {
    const matching = (pages ?? []).filter(predicate);

    return matching.find(isPageOnScreen) ?? matching[0];
};

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

/**
 * A message-level adapter between the client and the socket, for protocols that wrap CDP-shaped
 * messages (WebKit's target routing on iOS). It sends frames with `sendUpstream` and hands plain
 * messages back through `deliver`.
 */
export interface TransportAdapter {
    onUpstream(raw: string): void;
    send(raw: string): void;
    dispose(): void;
}

export type TransportAdapterFactory = (io: {
    sendUpstream: (raw: string) => void;
    deliver: (raw: string) => void;
}) => TransportAdapter;

export interface ConnectCdpOptions {
    /** Wraps the socket (see `TransportAdapter`). Default: plain CDP frames. */
    adapter?: TransportAdapterFactory;
}

export const connectCdp = async (
    webSocketDebuggerUrl: string,
    { adapter }: ConnectCdpOptions = {},
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

    log.debug(`socket open ${webSocketDebuggerUrl}`, { adapter: Boolean(adapter) });

    const wrapped = adapter?.({ sendUpstream: (raw) => ws.send(raw), deliver: handleMessage });
    const receive = wrapped ? (raw: string) => wrapped.onUpstream(raw) : handleMessage;
    const transmit = wrapped ? (raw: string) => wrapped.send(raw) : (raw: string) => ws.send(raw);

    ws.onmessage = ({ data }) => receive(String(data));

    const closed = new Promise<void>((resolve) => {
        ws.onclose = () => {
            log.debug(`socket closed ${webSocketDebuggerUrl}`, { pending: pending.size });
            wrapped?.dispose();
            for (const { reject } of pending.values())
                reject(new Error('DevTools connection closed'));
            pending.clear();
            resolve();
        };
    });

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
                transmit(JSON.stringify({ id: nextId, method, params }));
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
            wrapped?.dispose();
            ws.close();
        },
        closed,
    };
};
