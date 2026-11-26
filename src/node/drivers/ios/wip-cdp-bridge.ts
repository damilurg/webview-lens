// Bidirectional WebKit Inspector Protocol (WIP) ↔ Chrome DevTools Protocol (CDP) translator.
// Enables running unified telemetry, lab vitals and Chrome DevTools against iOS WKWebView
// on both Windows and macOS.

import { rec } from '../../../shared/decode.ts';
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
    // WebKit has no Page.navigate (verified on iOS 26): navigate from the page itself.
    if (method === 'Page.navigate') {
        return {
            method: 'Runtime.evaluate',
            params: {
                expression: `location.assign(${JSON.stringify(String(params.url ?? ''))})`,
                returnByValue: true,
            },
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

export interface WipEventContext {
    /** CDP execution context of the page's main world, attached to console events. */
    executionContextId?: number | undefined;
    /** Clock for events WebKit sends without a timestamp. Default: `Date.now`. */
    now?: () => number;
}

export interface ExecutionContextTracker {
    /** Feeds a WIP event; returns true when it was a context lifecycle event. */
    observe(method: string, params: unknown): boolean;
    readonly mainContextId: number | undefined;
}

/**
 * Tracks the main-world execution context id from WIP `Runtime.executionContext*` events: the first
 * page context created after `executionContextsCleared` (a main-frame navigation) is the main frame's.
 */
export const createExecutionContextTracker = (): ExecutionContextTracker => {
    let mainContextId: number | undefined;

    return {
        observe(method: string, params: unknown): boolean {
            if (method === 'Runtime.executionContextsCleared') {
                mainContextId = undefined;

                return true;
            }
            if (method !== 'Runtime.executionContextCreated') return false;

            const context = isRecord(params) && isRecord(params.context) ? params.context : {};
            const isPageContext = context.isPageContext === true || context.type === 'normal';

            if (mainContextId === undefined && isPageContext && typeof context.id === 'number') {
                mainContextId = context.id;
            }

            return true;
        },
        get mainContextId() {
            return mainContextId;
        },
    };
};

/** WebKit console timestamps are seconds since epoch; CDP's are milliseconds. */
const toCdpTimestamp = (value: unknown, now: () => number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : now();

const toZeroBased = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value - 1) : undefined;

/** Translates a WebKit Inspector Protocol event into its CDP equivalent. */
export const translateWipEventToCdp = (
    method: string,
    params: unknown,
    { executionContextId, now = Date.now }: WipEventContext = {},
): ProtocolMessage | null => {
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
                timestamp: toCdpTimestamp(msg.timestamp, now),
                ...(executionContextId !== undefined ? { executionContextId } : {}),
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
    const contexts = createExecutionContextTracker();

    for (const method of ['Runtime.executionContextCreated', 'Runtime.executionContextsCleared']) {
        rawWip.on(method, (params) => void contexts.observe(method, params));
    }

    const ensureWipSubscription = (wipMethod: string) => {
        if (subscribedWipMethods.has(wipMethod)) return;
        subscribedWipMethods.add(wipMethod);
        rawWip.on(wipMethod, (rawParams) => {
            const translated = translateWipEventToCdp(wipMethod, rawParams, {
                executionContextId: contexts.mainContextId,
            });

            if (!translated) return;
            for (const listener of cdpListeners.get(translated.method) ?? []) {
                listener(translated.params);
            }
        });
    };

    const on = (cdpMethod: string, listener: (params: unknown) => void) => {
        const set = cdpListeners.get(cdpMethod) ?? new Set();

        set.add(listener);
        cdpListeners.set(cdpMethod, set);

        if (cdpMethod === 'Runtime.consoleAPICalled') {
            ensureWipSubscription('Console.messageAdded');
        }
        ensureWipSubscription(cdpMethod);

        return () => {
            set.delete(listener);
        };
    };

    return {
        async send(method: string, params: object = {}): Promise<unknown> {
            const translated = translateCdpToWip(method, rec(params) ?? {});
            const result = await rawWip.send(translated.method, translated.params);

            return translateWipResultToCdp(method, result);
        },
        on,
        once: (method: string) =>
            new Promise<unknown>((resolve) => {
                const off = on(method, (params) => {
                    off();
                    resolve(params);
                });
            }),
        close: () => rawWip.close(),
        closed: rawWip.closed,
    };
};
