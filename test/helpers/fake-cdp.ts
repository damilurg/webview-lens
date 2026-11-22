import type { Cdp } from '../../src/node/cdp.ts';
import { sleep } from '../../src/shared/utils.ts';

export interface FakeCdpCall {
    method: string;
    params: unknown;
}

export interface FakeCdpOptions {
    cookies?: { name: string; value: string }[];
}

/** Shared in-memory CDP fake for BDD tests (zero TCP sockets). */
export const createFakeCdp = ({ cookies = [] }: FakeCdpOptions = {}) => {
    const calls: FakeCdpCall[] = [];
    const listeners = new Map<string, Set<(params: unknown) => void>>();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const cdp: Cdp = {
        send: async <T>(method: string, params: object = {}) => {
            calls.push({ method, params });
            if (method === 'Network.getCookies') {
                return { cookies } as T;
            }

            return {} as T;
        },
        on: <T>(method: string, listener: (params: T) => void) => {
            const set = listeners.get(method) ?? new Set();
            const fn = listener as (params: unknown) => void;

            set.add(fn);
            listeners.set(method, set);

            return () => set.delete(fn);
        },
        once: <T>(method: string) =>
            new Promise<T>((resolve) => {
                const off = cdp.on<T>(method, (params) => {
                    off();
                    resolve(params);
                });
            }),
        close: () => resolveClosed(),
        closed,
    };

    const emit = (method: string, params: unknown) => {
        for (const listener of listeners.get(method) ?? []) listener(params);
    };

    const waitForCalls = async (
        method: string,
        count = 1,
        timeoutMs = 1000,
    ): Promise<FakeCdpCall[]> => {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const found = calls.filter((c) => c.method === method);

            if (found.length >= count) return found;
            await sleep(5);
        }
        throw new Error(`Timed out waiting for ${count} CDP call(s): ${method}`);
    };

    const waitForCall = async (method: string, timeoutMs = 1000): Promise<FakeCdpCall> =>
        (await waitForCalls(method, 1, timeoutMs))[0]!;

    return { cdp, calls, emit, waitForCall, waitForCalls };
};
