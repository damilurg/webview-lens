import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Cdp } from '../src/node/cdp.ts';
import { createProtocolInspectorSession } from '../src/node/drivers/base-session.ts';
import { translateWipResultToCdp } from '../src/node/drivers/ios/wip-cdp-bridge.ts';

/** A transport that answers by method, in the shapes Chrome (cdp) or WebKit-through-the-bridge send. */
const sessionWith = (answers: Record<string, (params: Record<string, unknown>) => unknown>) => {
    const calls: string[] = [];
    const transport = {
        send: async (method: string, params: Record<string, unknown> = {}) => {
            calls.push(method);

            const answer = answers[method];

            if (!answer) throw new Error(`unexpected ${method}`);

            return answer(params);
        },
    } as Pick<Cdp, 'send'> as Cdp;
    const session = createProtocolInspectorSession(transport, {
        platform: 'android',
        capabilities: { lcp: true, cls: true, inp: true, cdpFetchOverride: true },
        enableTelemetry: async () => undefined,
    });

    return { session, calls };
};

describe('InspectorSession.evaluate', () => {
    it('without awaitPromise: by value, one call (a promise comes back as {})', async () => {
        const { session, calls } = sessionWith({
            'Runtime.evaluate': ({ returnByValue }) => ({
                result: { type: 'object', value: returnByValue ? {} : undefined },
            }),
        });

        assert.deepEqual(await session.evaluate('fetch("/")'), {});
        assert.deepEqual(calls, ['Runtime.evaluate']);
    });

    it('awaitPromise, Chrome promise (subtype): awaited by id', async () => {
        const { session, calls } = sessionWith({
            'Runtime.evaluate': () => ({
                result: { type: 'object', subtype: 'promise', objectId: 'p1' },
            }),
            'Runtime.awaitPromise': ({ promiseObjectId }) => ({
                result: { type: 'number', value: promiseObjectId === 'p1' ? 200 : 0 },
            }),
        });

        assert.equal(
            await session.evaluate('fetch("/").then((r) => r.status)', { awaitPromise: true }),
            200,
        );
        assert.deepEqual(calls, ['Runtime.evaluate', 'Runtime.awaitPromise']);
    });

    it('awaitPromise, WebKit promise (className only, as on iOS 26)', async () => {
        const { session } = sessionWith({
            'Runtime.evaluate': () => ({
                result: { type: 'object', className: 'Promise', objectId: '{"id":1}' },
            }),
            'Runtime.awaitPromise': () => ({ result: { type: 'object', value: { status: 200 } } }),
        });

        assert.deepEqual(await session.evaluate('p', { awaitPromise: true }), { status: 200 });
    });

    it('awaitPromise, an object that is not a promise: read once by id, the expression is not run again', async () => {
        const { session, calls } = sessionWith({
            'Runtime.evaluate': () => ({
                result: { type: 'object', className: 'Object', objectId: 'o1' },
            }),
            'Runtime.callFunctionOn': ({ objectId }) => ({ result: { value: { id: objectId } } }),
        });

        assert.deepEqual(await session.evaluate('({})', { awaitPromise: true }), { id: 'o1' });
        assert.deepEqual(calls, ['Runtime.evaluate', 'Runtime.callFunctionOn']);
    });

    it('awaitPromise, a primitive: no second call', async () => {
        const { session, calls } = sessionWith({
            'Runtime.evaluate': () => ({ result: { type: 'number', value: 2 } }),
        });

        assert.equal(await session.evaluate('1 + 1', { awaitPromise: true }), 2);
        assert.deepEqual(calls, ['Runtime.evaluate']);
    });

    it('awaitPromise: a throw or a rejection gives undefined (WebKit wasThrown translated)', async () => {
        const threw = sessionWith({
            'Runtime.evaluate': () => ({
                result: { type: 'object' },
                exceptionDetails: { text: 'boom' },
            }),
        });
        const rejected = sessionWith({
            'Runtime.evaluate': () => ({
                result: { type: 'object', className: 'Promise', objectId: 'p' },
            }),
            'Runtime.awaitPromise': () =>
                translateWipResultToCdp('Runtime.awaitPromise', {
                    result: { type: 'object', subtype: 'error', description: 'Error: nope' },
                    wasThrown: true,
                }),
        });

        assert.equal(await threw.session.evaluate('throw 1', { awaitPromise: true }), undefined);
        assert.equal(threw.calls.length, 1);
        assert.equal(
            await rejected.session.evaluate('Promise.reject()', { awaitPromise: true }),
            undefined,
        );
    });
});
