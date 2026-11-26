// Live telemetry from a WebView page over CDP: console logs, uncaught exceptions and network errors.

import type { Cdp } from './cdp.ts';
import {
    decodeConsoleEvent,
    decodeExceptionEvent,
    decodeLoadingFailed,
    decodeRequestId,
    decodeRequestWillBeSent,
    decodeResponseReceived,
    subscribe,
} from './protocol.ts';

// The page's console is what attachTelemetry is called for, so by default it is printed (unlike the
// library's own diagnostics, which stay in the logger until asked for). Pass log / error to redirect.
const printLine = (line: string): void => {
    process.stdout.write(`${line}\n`);
};
const printError = (line: string): void => {
    process.stderr.write(`${line}\n`);
};

/**
 * On enable, WebKit and V8 resend the messages already in the page's console, so a second attach to
 * the same page would show them again as new. Older than this before the attach: history.
 * (Device and computer clocks were 0.2 s apart on the test iPhone; this keeps a wide margin.)
 */
const EARLIER_MARGIN_MS = 2000;

export interface RemoteObjectPreviewProperty {
    name: string;
    value?: string;
}

export interface RemoteObject {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    unserializableValue?: string;
    preview?: {
        properties?: readonly RemoteObjectPreviewProperty[];
    };
}

export interface CallFrame {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
}

export interface StackTrace {
    callFrames?: readonly CallFrame[];
}

export interface ConsoleEvent {
    type: string;
    args: readonly RemoteObject[];
    stackTrace?: StackTrace;
    /** Milliseconds since the epoch, by the device's clock. */
    timestamp?: number;
}

export interface ExceptionEvent {
    exceptionDetails: {
        text: string;
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
        exception?: RemoteObject;
        stackTrace?: StackTrace;
    };
}

export interface NetworkErrorEvent {
    kind: 'failed' | 'http';
    url: string;
    method?: string;
    status?: number;
    errorText?: string;
}

export interface TelemetryOptions {
    /** Console levels to print (normalized: `warning` → `warn`). Default: all levels. */
    levels?: readonly string[];
    /** Report failed requests and HTTP >= 400 responses. Default: true. */
    networkErrors?: boolean;
    /** Console lines and network errors. Default: stdout and stderr. */
    log?: (line: string) => void;
    error?: (line: string) => void;
    /**
     * Messages that were in the page's console before the attach (resent on enable): `mark` prints
     * them with `(earlier)`, `skip` drops them. Default: `mark`.
     */
    earlier?: 'mark' | 'skip';
    /** Clock for telling earlier messages apart (tests). Default: Date.now. */
    now?: () => number;
}

const normalizeConsoleLevel = (type: string): string => (type === 'warning' ? 'warn' : type);

/** Formats a CDP RemoteObject into a compact single-line representation. */
export const formatRemoteObject = (obj: RemoteObject): string => {
    if (obj.type === 'undefined') return 'undefined';
    if (obj.subtype === 'null') return 'null';
    if (obj.unserializableValue !== undefined) return obj.unserializableValue;
    if (obj.value !== undefined) {
        return typeof obj.value === 'string' ? obj.value : String(obj.value);
    }
    // An Error's description is "TypeError: msg\n    at …"; its preview only lists stack/message fields.
    if (obj.subtype === 'error' && obj.description) return obj.description;
    if (obj.preview?.properties?.length) {
        const props = obj.preview.properties.map((p) => `${p.name}: ${p.value ?? '…'}`).join(', ');

        return `{${props}}`;
    }

    return obj.description ?? `[${obj.type}]`;
};

/** Formats a URL and 0-based CDP line/column into a compact 1-based `path:line:col` label. */
export const formatLocation = (
    url?: string,
    lineNumber?: number,
    columnNumber?: number,
): string => {
    if (!url) return '';

    let label = url;

    try {
        const parsed = new URL(url);

        label = parsed.pathname || url;
    } catch {
        // Keep raw URL/filename as-is.
    }

    if (typeof lineNumber !== 'number') return label;

    const line = lineNumber + 1;

    if (typeof columnNumber === 'number') return `${label}:${line}:${columnNumber + 1}`;

    return `${label}:${line}`;
};

export const formatConsoleEvent = (
    event: ConsoleEvent,
    { earlier = false }: { earlier?: boolean } = {},
): string => {
    const level = normalizeConsoleLevel(event.type);
    const text = event.args.map(formatRemoteObject).join(' ');
    const frame = event.stackTrace?.callFrames?.[0];
    const location = formatLocation(frame?.url, frame?.lineNumber, frame?.columnNumber);

    return `[console.${level}]${earlier ? ' (earlier)' : ''} ${text}${location ? ` (${location})` : ''}`;
};

export const formatExceptionEvent = ({ exceptionDetails }: ExceptionEvent): string => {
    const message = exceptionDetails.exception
        ? formatRemoteObject(exceptionDetails.exception)
        : exceptionDetails.text;
    const frame = exceptionDetails.stackTrace?.callFrames?.[0];
    const location = formatLocation(
        exceptionDetails.url ?? frame?.url,
        exceptionDetails.lineNumber ?? frame?.lineNumber,
        exceptionDetails.columnNumber ?? frame?.columnNumber,
    );

    return `[exception] ${message}${location ? ` (${location})` : ''}`;
};

export const formatNetworkError = (event: NetworkErrorEvent): string => {
    const method = event.method ? `${event.method} ` : '';

    if (event.kind === 'http') {
        return `[network] ${event.status ?? 'ERR'} ${method}${event.url}`;
    }

    return `[network] FAIL ${method}${event.url}${event.errorText ? ` (${event.errorText})` : ''}`;
};

/**
 * Attaches live console, exception and network error listeners to an active CDP session.
 * Returns a detach function that unsubscribes all listeners.
 */
export const attachTelemetry = (
    cdp: Cdp,
    {
        levels,
        networkErrors = true,
        log = printLine,
        error = printError,
        earlier = 'mark',
        now = Date.now,
    }: TelemetryOptions = {},
): (() => void) => {
    const attachedAt = now();
    const allowedLevels = levels ? new Set(levels.map(normalizeConsoleLevel)) : null;
    const requests = new Map<string, { url: string; method?: string }>();
    const unsubs: (() => void)[] = [];

    unsubs.push(
        subscribe(cdp, 'Runtime.consoleAPICalled', decodeConsoleEvent, (event) => {
            const level = normalizeConsoleLevel(event.type);

            if (allowedLevels && !allowedLevels.has(level)) return;

            const isEarlier =
                event.timestamp !== undefined && event.timestamp < attachedAt - EARLIER_MARGIN_MS;

            if (isEarlier && earlier === 'skip') return;

            const line = formatConsoleEvent(event, { earlier: isEarlier });

            if (level === 'error' || level === 'assert') {
                error(line);

                return;
            }
            log(line);
        }),
    );

    unsubs.push(
        subscribe(cdp, 'Runtime.exceptionThrown', decodeExceptionEvent, (event) => {
            error(formatExceptionEvent(event));
        }),
    );

    if (networkErrors) {
        unsubs.push(
            subscribe(
                cdp,
                'Network.requestWillBeSent',
                decodeRequestWillBeSent,
                ({ requestId, request }) => {
                    // Keep memory bounded if long-lived requests never emit loadingFinished.
                    if (requests.size >= 500) {
                        const oldest = requests.keys().next().value;

                        if (oldest !== undefined) requests.delete(oldest);
                    }
                    requests.set(requestId, {
                        url: request.url,
                        ...(request.method ? { method: request.method } : {}),
                    });
                },
            ),
        );

        unsubs.push(
            subscribe(
                cdp,
                'Network.responseReceived',
                decodeResponseReceived,
                ({ requestId, response }) => {
                    if (response.status < 400) return;

                    const tracked = requests.get(requestId);

                    error(
                        formatNetworkError({
                            kind: 'http',
                            url: response.url || tracked?.url || '',
                            ...(tracked?.method ? { method: tracked.method } : {}),
                            status: response.status,
                        }),
                    );
                },
            ),
        );

        unsubs.push(
            subscribe(
                cdp,
                'Network.loadingFailed',
                decodeLoadingFailed,
                ({ requestId, errorText }) => {
                    const tracked = requests.get(requestId);

                    requests.delete(requestId);
                    error(
                        formatNetworkError({
                            kind: 'failed',
                            url: tracked?.url ?? requestId,
                            ...(tracked?.method ? { method: tracked.method } : {}),
                            ...(errorText ? { errorText } : {}),
                        }),
                    );
                },
            ),
        );

        unsubs.push(
            subscribe(cdp, 'Network.loadingFinished', decodeRequestId, ({ requestId }) => {
                requests.delete(requestId);
            }),
        );
    }

    return () => {
        for (const off of unsubs) off();
        requests.clear();
    };
};
