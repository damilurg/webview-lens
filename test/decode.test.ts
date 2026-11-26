import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    decodeBindingCall,
    decodeConsoleEvent,
    decodeCookies,
    decodeEvaluateResult,
    decodeExceptionEvent,
    decodePausedRequest,
    decodePerformanceMetrics,
    decodeRpcMessage,
    sendDecoded,
    subscribe,
} from '../src/node/protocol.ts';
import { decodeLabRun } from '../src/node/vitals-lab.ts';
import { list, num, oneOf, parseJson, someOf, str, stringMap } from '../src/shared/decode.ts';

describe('shared decoders', () => {
    it('narrow primitives and reject other shapes', () => {
        assert.equal(str('a'), 'a');
        assert.equal(str(1), undefined);
        assert.equal(num(3), 3);
        assert.equal(num(Number.NaN), undefined);
        assert.equal(num('3'), undefined);
        assert.equal(oneOf(['fail', 'continue'])('fail'), 'fail');
        assert.equal(oneOf(['fail', 'continue'])('maybe'), undefined);
    });

    it('list is all-or-nothing, someOf keeps the items that decode', () => {
        assert.deepEqual(list(num)([1, 2]), [1, 2]);
        assert.equal(list(num)([1, 'x']), undefined);
        assert.deepEqual(someOf(num)([1, 'x', 3]), [1, 3]);
        assert.equal(someOf(num)('nope'), undefined);
    });

    it('stringMap accepts only string values; parseJson never throws', () => {
        assert.deepEqual(stringMap({ a: 'b' }), { a: 'b' });
        assert.equal(stringMap({ a: 1 }), undefined);
        assert.equal(parseJson('{'), undefined);
        assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
    });
});

describe('protocol decoders', () => {
    it('decode replies, errors and events; skip non-objects', () => {
        assert.deepEqual(decodeRpcMessage({ id: 3, result: { ok: true } }), {
            id: 3,
            result: { ok: true },
        });
        assert.deepEqual(decodeRpcMessage({ id: 4, error: { code: -32601 } }), {
            id: 4,
            error: { message: 'protocol error' },
        });
        assert.deepEqual(decodeRpcMessage({ method: 'Page.loadEventFired', params: {} }), {
            method: 'Page.loadEventFired',
            params: {},
        });
        assert.equal(decodeRpcMessage([1, 2]), undefined);
        assert.equal(decodeRpcMessage('frame'), undefined);
    });

    it('drop a console event without type or args, keep odd args out', () => {
        assert.equal(decodeConsoleEvent({ args: [] }), undefined);
        assert.deepEqual(
            decodeConsoleEvent({ type: 'log', args: [{ type: 'string', value: 'hi' }, 7] }),
            {
                type: 'log',
                args: [{ type: 'string', value: 'hi' }],
            },
        );
    });

    it('keep exception details even when the frame is sparse', () => {
        assert.deepEqual(decodeExceptionEvent({ exceptionDetails: { lineNumber: 4 } }), {
            exceptionDetails: { text: 'Uncaught', lineNumber: 4 },
        });
        assert.equal(decodeExceptionEvent({}), undefined);
    });

    it('validate a paused request: url and method required, headers must be strings', () => {
        assert.equal(
            decodePausedRequest({ requestId: '1', request: { url: 'https://a/' } }),
            undefined,
        );
        assert.deepEqual(
            decodePausedRequest({
                requestId: '1',
                request: { url: 'https://a/', method: 'POST', headers: { a: 1 }, postData: 'x' },
            }),
            {
                requestId: '1',
                request: { url: 'https://a/', method: 'POST', headers: {}, postData: 'x' },
            },
        );
    });

    it('read bindings, cookies, evaluate results and heap metrics', () => {
        assert.equal(decodeBindingCall({ name: 'b', payload: 5 }), undefined);
        assert.deepEqual(decodeCookies({ cookies: [{ name: 's', value: 'v' }, { name: 1 }] }), [
            { name: 's', value: 'v' },
        ]);
        assert.deepEqual(decodeEvaluateResult({ result: { type: 'number', value: 2 } }), {
            value: 2,
        });
        assert.deepEqual(
            decodeEvaluateResult({
                exceptionDetails: { text: 'Uncaught', exception: { description: 'Boom' } },
            }),
            { value: undefined, exception: 'Boom' },
        );
        assert.equal(
            decodePerformanceMetrics({
                metrics: [{ name: 'JSHeapUsedSize', value: 2048 }, { name: 'x' }],
            })?.get('JSHeapUsedSize'),
            2048,
        );
    });

    it('subscribe skips frames that do not decode; sendDecoded rejects with the method', async () => {
        let listener: ((params: unknown) => void) | undefined;
        const seen: string[] = [];

        subscribe(
            {
                on: (_method, fn) => {
                    listener = fn;

                    return () => undefined;
                },
            },
            'Runtime.bindingCalled',
            decodeBindingCall,
            ({ payload }) => seen.push(payload),
        );
        listener?.({ name: 'b' });
        listener?.({ name: 'b', payload: 'ok' });
        assert.deepEqual(seen, ['ok']);

        await assert.rejects(
            sendDecoded(
                { send: async () => ({ nope: true }) },
                'Network.getCookies',
                {},
                decodeCookies,
            ),
            /Network\.getCookies: unexpected result/,
        );
    });
});

describe('lab vitals decoder', () => {
    it('reads the collector output field by field', () => {
        assert.deepEqual(
            decodeLabRun({
                lcp: 812,
                fcp: 300,
                cls: null,
                inp: 'x',
                ttfb: 90,
                shifts: [0.01],
                marks: { a: 5, b: 'no' },
            }),
            { lcp: 812, fcp: 300, cls: null, inp: null, ttfb: 90, shifts: [0.01], marks: { a: 5 } },
        );
        assert.equal(decodeLabRun(null), undefined);
    });
});
