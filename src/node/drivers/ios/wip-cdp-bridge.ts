// Bidirectional WebKit Inspector Protocol (WIP) ↔ Chrome DevTools Protocol (CDP) translator.
// Enables running unified telemetry, lab vitals and Chrome DevTools against iOS WKWebView
// on both Windows and macOS.

import { isRecord } from '../../../shared/utils.ts';
import type { Cdp } from '../../cdp.ts';

export interface ProtocolMessage {
    method: string;
    params: Record<string, unknown>;
}

/** Translates a CDP command name and params into the WebKit Inspector Protocol equivalent. */
export const translateCdpToWip = (
    method: string,
    params: Record<string, unknown> = {},
): ProtocolMessage => {
    if (method === 'Network.setCacheDisabled') {
        return {
            method: 'Network.setResourceCachingDisabled',
            params: { disabled: Boolean(params.cacheDisabled) },
        };
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return {
            method: 'Page.setBootstrapScript',
            params: { source: String(params.source ?? '') },
        };
    }
    if (method === 'Runtime.evaluate') {
        return {
            method: 'Runtime.evaluate',
            params: {
                expression: params.expression,
                returnByValue: Boolean(params.returnByValue),
                objectGroup: 'console',
            },
        };
    }

    return { method, params };
};

/** Translates a WebKit Inspector Protocol command result into CDP shape. */
export const translateWipResultToCdp = (method: string, result: unknown): unknown => {
    if (method === 'Runtime.evaluate' && isRecord(result) && result.wasThrown === true) {
        const exception = isRecord(result.result) ? result.result : undefined;
        const text =
            typeof exception?.description === 'string'
                ? exception.description
                : 'Uncaught exception';

        return {
            result: result.result,
            exceptionDetails: {
                text,
                ...(exception ? { exception } : {}),
            },
        };
    }

    return result;
};

const toZeroBased = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value - 1) : undefined;

/** Translates a WebKit Inspector Protocol event into its CDP equivalent. */
export const translateWipEventToCdp = (method: string, params: unknown): ProtocolMessage | null => {
    if (method === 'Console.messageAdded' && isRecord(params) && isRecord(params.message)) {
        const msg = params.message;
        const level = typeof msg.level === 'string' ? msg.level : 'log';
        const args =
            Array.isArray(msg.parameters) && msg.parameters.length > 0
                ? msg.parameters
                : [{ type: 'string', value: String(msg.text ?? '') }];
        const lineNumber = toZeroBased(msg.line);
        const columnNumber = toZeroBased(msg.column);
        const url = typeof msg.url === 'string' ? msg.url : undefined;
        const stackTrace = url
            ? {
                  callFrames: [
                      {
                          url,
                          ...(lineNumber !== undefined ? { lineNumber } : {}),
                          ...(columnNumber !== undefined ? { columnNumber } : {}),
                      },
                  ],
              }
            : undefined;

        return {
            method: 'Runtime.consoleAPICalled',
            params: {
                type: level,
                args,
                ...(stackTrace ? { stackTrace } : {}),
            },
        };
    }

    if (method === 'Network.loadingFailed' && isRecord(params)) {
        return {
            method: 'Network.loadingFailed',
            params: {
                ...params,
                errorText:
                    typeof params.errorText === 'string'
                        ? params.errorText
                        : typeof params.localizedDescription === 'string'
                          ? params.localizedDescription
                          : 'Network error',
            },
        };
    }

    return { method, params: isRecord(params) ? params : {} };
};

/**
 * Wraps a raw WebKit Inspector Protocol socket (`Cdp`-shaped transport) so callers can speak CDP
 * commands and subscribe to CDP events transparently.
 */
export const createWipCdpBridge = (rawWip: Cdp): Cdp => {
    const cdpListeners = new Map<string, Set<(params: unknown) => void>>();
    const subscribedWipMethods = new Set<string>();

    const ensureWipSubscription = (wipMethod: string) => {
        if (subscribedWipMethods.has(wipMethod)) return;
        subscribedWipMethods.add(wipMethod);
        rawWip.on(wipMethod, (rawParams) => {
            const translated = translateWipEventToCdp(wipMethod, rawParams);

            if (!translated) return;
            for (const listener of cdpListeners.get(translated.method) ?? []) {
                listener(translated.params);
            }
        });
    };

    const on = <T>(cdpMethod: string, listener: (params: T) => void) => {
        const set = cdpListeners.get(cdpMethod) ?? new Set();
        const untyped = listener as (params: unknown) => void;

        set.add(untyped);
        cdpListeners.set(cdpMethod, set);

        if (cdpMethod === 'Runtime.consoleAPICalled') {
            ensureWipSubscription('Console.messageAdded');
        }
        ensureWipSubscription(cdpMethod);

        return () => {
            set.delete(untyped);
        };
    };

    return {
        async send<T = unknown>(method: string, params: object = {}): Promise<T> {
            const translated = translateCdpToWip(method, params as Record<string, unknown>);
            const result = await rawWip.send(translated.method, translated.params);

            return translateWipResultToCdp(method, result) as T;
        },
        on,
        once: <T>(method: string) =>
            new Promise<T>((resolve) => {
                const off = on<T>(method, (params) => {
                    off();
                    resolve(params);
                });
            }),
        close: () => rawWip.close(),
        closed: rawWip.closed,
    };
};
