// A minimal Chrome DevTools Protocol client over the global WebSocket (Node 22.4+).

export interface DevtoolsPage {
    id: string;
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
    devtoolsFrontendUrl?: string;
}

export type PagePredicate = (page: DevtoolsPage) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isDevtoolsPage = (value: unknown): value is DevtoolsPage =>
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.url === 'string' &&
    typeof value.webSocketDebuggerUrl === 'string';

/** Pages on the DevTools port; null when the port does not answer (no forward, or a stale socket). */
export const listPages = async (port: string | number): Promise<DevtoolsPage[] | null> => {
    try {
        const response = await fetch(`http://localhost:${port}/json/list`);

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
        const data: unknown = await (await fetch(`http://localhost:${port}/json/version`)).json();

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

export const connectCdp = async (webSocketDebuggerUrl: string): Promise<Cdp> => {
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

    const closed = new Promise<void>((resolve) => {
        ws.onclose = () => {
            for (const { reject } of pending.values())
                reject(new Error('DevTools connection closed'));
            pending.clear();
            resolve();
        };
    });

    ws.onmessage = ({ data }) => {
        const message: Message = JSON.parse(String(data));

        if (message.id !== undefined) {
            const call = pending.get(message.id);

            pending.delete(message.id);
            if (message.error) call?.reject(new Error(message.error.message));
            else call?.resolve(message.result);

            return;
        }
        if (message.method)
            listeners.get(message.method)?.forEach((listener) => listener(message.params));
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
                ws.send(JSON.stringify({ id: nextId, method, params }));
            }),
        on,
        once: <T>(method: string) =>
            new Promise<T>((resolve) => {
                const off = on<T>(method, (params) => {
                    off();
                    resolve(params);
                });
            }),
        close: () => ws.close(),
        closed,
    };
};
