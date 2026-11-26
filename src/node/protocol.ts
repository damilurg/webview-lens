// Decoders for the DevTools protocol messages webview-lens reads. The transport hands out `unknown`
// (a phone, a proxy or a page script is on the other end); these turn it into the fields we use, or
// `undefined` when the shape is not what the protocol promises.

import { type Decoder, list, num, rec, someOf, str, stringMap } from '../shared/decode.ts';
import { isRecord } from '../shared/utils.ts';
import type { Cdp } from './cdp.ts';
import type {
    CallFrame,
    ConsoleEvent,
    ExceptionEvent,
    RemoteObject,
    RemoteObjectPreviewProperty,
    StackTrace,
} from './telemetry.ts';

// --- JSON-RPC frames --------------------------------------------------------------------------

/** One protocol frame: a command, a reply (`id`) or an event (`method` without `id`). */
export interface RpcMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message: string };
}

export const decodeRpcMessage: Decoder<RpcMessage> = (input) => {
    if (!isRecord(input)) return undefined;

    const id = num(input.id);
    const method = str(input.method);
    const params = rec(input.params);
    const error = rec(input.error);

    return {
        ...(id !== undefined ? { id } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(params !== undefined ? { params } : {}),
        ...('result' in input ? { result: input.result } : {}),
        ...(error ? { error: { message: str(error.message) ?? 'protocol error' } } : {}),
    };
};

/**
 * Subscribes to an event and calls `listener` only with params that decode; frames of another
 * shape (an older browser, a proxy in between) are skipped instead of crashing the listener.
 */
export const subscribe = <T>(
    cdp: Pick<Cdp, 'on'>,
    method: string,
    decode: Decoder<T>,
    listener: (params: T) => void,
): (() => void) =>
    cdp.on(method, (params) => {
        const decoded = decode(params);

        if (decoded !== undefined) listener(decoded);
    });

/** Sends a command and decodes its result; a result of another shape rejects with the method name. */
export const sendDecoded = async <T>(
    cdp: Pick<Cdp, 'send'>,
    method: string,
    params: object,
    decode: Decoder<T>,
): Promise<T> => {
    const decoded = decode(await cdp.send(method, params));

    if (decoded === undefined) throw new Error(`${method}: unexpected result from the page`);

    return decoded;
};

// --- Runtime ----------------------------------------------------------------------------------

const decodePreviewProperty: Decoder<RemoteObjectPreviewProperty> = (input) => {
    if (!isRecord(input)) return undefined;

    const name = str(input.name);

    if (name === undefined) return undefined;

    const value = str(input.value);

    return value === undefined ? { name } : { name, value };
};

export const decodeRemoteObject: Decoder<RemoteObject> = (input) => {
    if (!isRecord(input)) return undefined;

    // Translated or older frames may omit `type`; `description` is what gets printed anyway.
    const type = str(input.type) ?? 'object';
    const subtype = str(input.subtype);
    const description = str(input.description);
    const unserializableValue = str(input.unserializableValue);
    const preview = rec(input.preview);
    const properties = preview ? someOf(decodePreviewProperty)(preview.properties) : undefined;

    return {
        type,
        ...('value' in input ? { value: input.value } : {}),
        ...(subtype !== undefined ? { subtype } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(unserializableValue !== undefined ? { unserializableValue } : {}),
        ...(preview ? { preview: properties ? { properties } : {} } : {}),
    };
};

const decodeCallFrame: Decoder<CallFrame> = (input) => {
    if (!isRecord(input)) return undefined;

    const url = str(input.url);
    const lineNumber = num(input.lineNumber);
    const columnNumber = num(input.columnNumber);

    return {
        ...(url !== undefined ? { url } : {}),
        ...(lineNumber !== undefined ? { lineNumber } : {}),
        ...(columnNumber !== undefined ? { columnNumber } : {}),
    };
};

const decodeStackTrace: Decoder<StackTrace> = (input) => {
    if (!isRecord(input)) return undefined;

    const callFrames = someOf(decodeCallFrame)(input.callFrames);

    return callFrames ? { callFrames } : {};
};

export const decodeConsoleEvent: Decoder<ConsoleEvent> = (input) => {
    if (!isRecord(input)) return undefined;

    const type = str(input.type);
    const args = someOf(decodeRemoteObject)(input.args);

    if (type === undefined || args === undefined) return undefined;

    const stackTrace = decodeStackTrace(input.stackTrace);

    return stackTrace ? { type, args, stackTrace } : { type, args };
};

export const decodeExceptionEvent: Decoder<ExceptionEvent> = (input) => {
    const details = isRecord(input) ? rec(input.exceptionDetails) : undefined;

    if (!details) return undefined;

    const location = decodeCallFrame(details) ?? {};
    const exception = decodeRemoteObject(details.exception);
    const stackTrace = decodeStackTrace(details.stackTrace);

    return {
        exceptionDetails: {
            text: str(details.text) ?? 'Uncaught',
            ...location,
            ...(exception ? { exception } : {}),
            ...(stackTrace ? { stackTrace } : {}),
        },
    };
};

export interface BindingCall {
    name: string;
    payload: string;
}

export const decodeBindingCall: Decoder<BindingCall> = (input) => {
    if (!isRecord(input)) return undefined;

    const name = str(input.name);
    const payload = str(input.payload);

    return name !== undefined && payload !== undefined ? { name, payload } : undefined;
};

/** `Runtime.evaluate` result: the returned value (by value) or the exception text. */
export interface EvaluateResult {
    value: unknown;
    exception?: string;
}

export const decodeEvaluateResult: Decoder<EvaluateResult> = (input) => {
    if (!isRecord(input)) return undefined;

    const result = rec(input.result);
    const details = rec(input.exceptionDetails);

    if (!details) return { value: result?.value };

    const exception = decodeRemoteObject(details.exception);

    return {
        value: undefined,
        exception: exception?.description ?? str(details.text) ?? 'evaluation failed',
    };
};

// --- Network / Fetch --------------------------------------------------------------------------

export interface RequestWillBeSent {
    requestId: string;
    request: { url: string; method?: string };
}

export const decodeRequestWillBeSent: Decoder<RequestWillBeSent> = (input) => {
    const request = isRecord(input) ? rec(input.request) : undefined;
    const requestId = isRecord(input) ? str(input.requestId) : undefined;
    const url = request ? str(request.url) : undefined;

    if (!request || requestId === undefined || url === undefined) return undefined;

    const method = str(request.method);

    return { requestId, request: method === undefined ? { url } : { url, method } };
};

export interface ResponseReceived {
    requestId: string;
    response: { url: string; status: number };
}

export const decodeResponseReceived: Decoder<ResponseReceived> = (input) => {
    const response = isRecord(input) ? rec(input.response) : undefined;
    const requestId = isRecord(input) ? str(input.requestId) : undefined;
    const status = response ? num(response.status) : undefined;

    if (!response || requestId === undefined || status === undefined) return undefined;

    return { requestId, response: { url: str(response.url) ?? '', status } };
};

export interface LoadingFailed {
    requestId: string;
    errorText?: string;
}

export const decodeLoadingFailed: Decoder<LoadingFailed> = (input) => {
    const requestId = isRecord(input) ? str(input.requestId) : undefined;

    if (requestId === undefined) return undefined;

    const errorText = isRecord(input) ? str(input.errorText) : undefined;

    return errorText === undefined ? { requestId } : { requestId, errorText };
};

export const decodeRequestId: Decoder<{ requestId: string }> = (input) => {
    const requestId = isRecord(input) ? str(input.requestId) : undefined;

    return requestId === undefined ? undefined : { requestId };
};

export interface PausedRequest {
    requestId: string;
    request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        postData?: string;
        postDataEntries?: { bytes?: string }[];
    };
}

const decodePostDataEntry: Decoder<{ bytes?: string }> = (input) => {
    if (!isRecord(input)) return undefined;

    const bytes = str(input.bytes);

    return bytes === undefined ? {} : { bytes };
};

export const decodePausedRequest: Decoder<PausedRequest> = (input) => {
    if (!isRecord(input)) return undefined;

    const requestId = str(input.requestId);
    const request = rec(input.request);
    const url = request ? str(request.url) : undefined;
    const method = request ? str(request.method) : undefined;

    if (!request || requestId === undefined || url === undefined || method === undefined) {
        return undefined;
    }

    const postData = str(request.postData);
    const postDataEntries = list(decodePostDataEntry)(request.postDataEntries);

    return {
        requestId,
        request: {
            url,
            method,
            headers: stringMap(request.headers) ?? {},
            ...(postData !== undefined ? { postData } : {}),
            ...(postDataEntries ? { postDataEntries } : {}),
        },
    };
};

export interface Cookie {
    name: string;
    value: string;
}

const decodeCookie: Decoder<Cookie> = (input) => {
    if (!isRecord(input)) return undefined;

    const name = str(input.name);
    const value = str(input.value);

    return name !== undefined && value !== undefined ? { name, value } : undefined;
};

/** `Network.getCookies` → the cookies (odd entries skipped). */
export const decodeCookies: Decoder<Cookie[]> = (input) =>
    isRecord(input) ? someOf(decodeCookie)(input.cookies) : undefined;

// --- Performance ------------------------------------------------------------------------------

/** `Performance.getMetrics` → metric name → value. */
export const decodePerformanceMetrics: Decoder<Map<string, number>> = (input) => {
    if (!isRecord(input) || !Array.isArray(input.metrics)) return undefined;

    const metrics = new Map<string, number>();

    for (const entry of input.metrics) {
        const name = isRecord(entry) ? str(entry.name) : undefined;
        const value = isRecord(entry) ? num(entry.value) : undefined;

        if (name !== undefined && value !== undefined) metrics.set(name, value);
    }

    return metrics;
};
