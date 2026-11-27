import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    translateCdpToWip,
    translateWipEventToCdp,
    translateWipResultToCdp,
} from '../src/node/drivers/ios/wip-cdp-bridge.ts';
import {
    createIosDevtoolsTranslator,
    wrapTopLevelAwait,
} from '../src/node/drivers/ios/devtools-bridge.ts';

describe('WIP ↔ CDP protocol translation', () => {
    it('translates CDP commands to WebKit Inspector Protocol equivalents', () => {
        assert.deepEqual(translateCdpToWip('Network.setCacheDisabled', { cacheDisabled: true }), {
            method: 'Network.setResourceCachingDisabled',
            params: { disabled: true },
        });
        assert.deepEqual(
            translateCdpToWip('Page.addScriptToEvaluateOnNewDocument', { source: 'window.x=1' }),
            { method: 'Page.setBootstrapScript', params: { source: 'window.x=1' } },
        );
        assert.deepEqual(
            translateCdpToWip('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
            {
                method: 'Runtime.evaluate',
                params: { expression: '1+1', returnByValue: true, objectGroup: 'console' },
            },
        );
        assert.deepEqual(translateCdpToWip('Debugger.resume', {}), {
            method: 'Debugger.resume',
            params: {},
        });
    });

    it('translates WebKit Console.messageAdded with 1-based line/column to CDP Runtime.consoleAPICalled with 0-based line/column', () => {
        const translated = translateWipEventToCdp('Console.messageAdded', {
            message: {
                source: 'console-api',
                level: 'warning',
                text: 'slow bridge',
                url: 'https://stand.test/app.js',
                line: 10,
                column: 5,
                timestamp: 1_700_000_000.5,
            },
        });

        assert.deepEqual(translated, {
            method: 'Runtime.consoleAPICalled',
            params: {
                type: 'warning',
                args: [{ type: 'string', value: 'slow bridge' }],
                timestamp: 1_700_000_000_500,
                stackTrace: {
                    callFrames: [
                        {
                            url: 'https://stand.test/app.js',
                            lineNumber: 9,
                            columnNumber: 4,
                        },
                    ],
                },
            },
        });
    });

    it('translates WebKit Network.loadingFailed localizedDescription to CDP errorText', () => {
        const translated = translateWipEventToCdp('Network.loadingFailed', {
            requestId: 'r1',
            localizedDescription: 'SSL error',
        });

        assert.deepEqual(translated, {
            method: 'Network.loadingFailed',
            params: {
                requestId: 'r1',
                localizedDescription: 'SSL error',
                errorText: 'SSL error',
            },
        });
    });

    it('translates WebKit Runtime.evaluate wasThrown to CDP exceptionDetails', () => {
        const result = translateWipResultToCdp('Runtime.evaluate', {
            result: { type: 'object', subtype: 'error', description: 'ReferenceError: x' },
            wasThrown: true,
        });

        assert.deepEqual(result, {
            result: { type: 'object', subtype: 'error', description: 'ReferenceError: x' },
            // DevTools prints text, then the exception's description: text is only the prefix.
            exceptionDetails: {
                text: 'Uncaught',
                exception: { type: 'object', subtype: 'error', description: 'ReferenceError: x' },
            },
        });
    });
});

describe('iOS DevTools translator internal commands', () => {
    it('swallows replies to bridge-originated commands instead of leaking them to the UI', () => {
        const translator = createIosDevtoolsTranslator();
        const command = JSON.parse(translator.internalCommand('Console.enable')) as { id: number };

        assert.equal(translator.fromUpstream(JSON.stringify({ id: command.id, result: {} })), null);
        // A second reply with the same id is no longer internal.
        assert.notEqual(
            translator.fromUpstream(JSON.stringify({ id: command.id, result: {} })),
            null,
        );
    });
});

describe('WIP console events carry CDP timestamp and main execution context', () => {
    it('tracks the main-world context across navigations and converts seconds to ms', () => {
        const translator = createIosDevtoolsTranslator();
        const consoleLine = (timestamp?: number) =>
            JSON.parse(
                translator.fromUpstream(
                    JSON.stringify({
                        method: 'Console.messageAdded',
                        params: { message: { level: 'log', text: 'hi', timestamp } },
                    }),
                ) ?? '{}',
            ) as { params: { timestamp: number; executionContextId?: number } };
        const event = (method: string, params: unknown = {}) =>
            translator.fromUpstream(JSON.stringify({ method, params }));

        event('Runtime.executionContextCreated', { context: { id: 3, type: 'normal' } });
        event('Runtime.executionContextCreated', { context: { id: 4, type: 'normal' } }); // iframe
        assert.deepEqual(consoleLine(1_700_000_000).params.executionContextId, 3);
        assert.equal(consoleLine(1_700_000_000).params.timestamp, 1_700_000_000_000);

        event('Runtime.executionContextsCleared');
        event('Runtime.executionContextCreated', { context: { id: 9, isPageContext: true } });
        assert.equal(consoleLine().params.executionContextId, 9);
        assert.ok(consoleLine().params.timestamp > 0);
    });
});

describe('WIP bridge: Page.navigate (found on iOS 26.6)', () => {
    it('translates Page.navigate, which WebKit lacks, into an in-page navigation', () => {
        assert.deepEqual(translateCdpToWip('Page.navigate', { url: 'https://stand.test/orders' }), {
            method: 'Runtime.evaluate',
            params: {
                expression: 'location.assign("https://stand.test/orders")',
                returnByValue: true,
            },
        });
    });
});

describe('Chrome DevTools Console over WebKit (checked in Chrome against the iPhone)', () => {
    it('a WebKit page context becomes a default CDP context the Console can pick ("top")', () => {
        // Exactly what iOS 26.6 sent.
        const translated = translateWipEventToCdp('Runtime.executionContextCreated', {
            context: { id: 4, type: 'normal', name: '', frameId: '0.1' },
        });

        assert.deepEqual(translated, {
            method: 'Runtime.executionContextCreated',
            params: {
                context: {
                    id: 4,
                    origin: '',
                    name: '',
                    uniqueId: '4',
                    auxData: { isDefault: true, type: 'default', frameId: '0.1' },
                },
            },
        });
    });

    it('a user or internal context (an extension, Web Inspector itself) is not the default', () => {
        const translated = translateWipEventToCdp('Runtime.executionContextCreated', {
            context: { id: 7, type: 'user', name: 'ext', frameId: '0.1' },
        });

        assert.deepEqual(translated?.params, {
            context: {
                id: 7,
                origin: '',
                name: 'ext',
                uniqueId: '7',
                auxData: { isDefault: false, type: 'isolated', frameId: '0.1' },
            },
        });
    });

    it("the Console's evaluate keeps its preview, command line API and context", () => {
        const { params } = translateCdpToWip('Runtime.evaluate', {
            expression: '({ a: 1 })',
            objectGroup: 'console',
            includeCommandLineAPI: true,
            generatePreview: true,
            silent: false,
            uniqueContextId: '4',
            replMode: true,
            userGesture: true,
        });

        assert.deepEqual(params, {
            expression: '({ a: 1 })',
            returnByValue: false,
            objectGroup: 'console',
            generatePreview: true,
            includeCommandLineAPI: true,
            contextId: 4,
        });
    });

    it('a Chrome-style uniqueContextId that is not a WebKit number is dropped (main context)', () => {
        const { params } = translateCdpToWip('Runtime.evaluate', {
            expression: '1',
            uniqueContextId: '-8274837.123',
            silent: true,
        });

        assert.deepEqual(params, {
            expression: '1',
            returnByValue: false,
            objectGroup: 'console',
            doNotPauseOnExceptionsAndMuteConsole: true,
        });
    });
});

describe('top-level await in the iOS Console (WebKit has no replMode)', () => {
    const run = async (code: string): Promise<unknown> => {
        const f = async (x: unknown) => x;

        // The wrapped command runs as the page would run it.
        return new Function('f', `return ${wrapTopLevelAwait(code)}`)(f);
    };

    it('the value of an awaited expression, and of the last statement (as in Chrome)', async () => {
        assert.equal(await run('await f(2)'), 2);
        assert.equal(await run('const r = await f({ s: 200 }); r.s'), 200);
        assert.equal(await run('const r = await f({ s: 1 }); r.s;'), 1);
    });

    it('semicolons and comments inside strings, templates and comments do not split it', async () => {
        assert.equal(await run("await f('a;b')"), 'a;b');
        assert.equal(await run('await f(`t;${1}`)'), 't;1');
        assert.equal(await run('/* a;b */ await f(7)'), 7);
        assert.equal(await run('await f(6) // trailing'), 6);
    });

    it('no value: a declaration last, a comment last, a block statement last (known: not returned)', async () => {
        assert.equal(await run('const x = await f(1)'), undefined);
        assert.equal(await run('await f(5); // c;d'), undefined);
        assert.equal(
            await run('let n = 0; for (const a of [1, 2]) { n += await f(a); } n'),
            undefined,
        );
    });

    it('the bridge awaits the promise and answers the Console command with its value', () => {
        const sent: unknown[] = [];
        const translator = createIosDevtoolsTranslator({
            sendUpstream: (raw) => sent.push(JSON.parse(raw)),
        });
        const forwarded = translator.fromClient(
            JSON.stringify({
                id: 7,
                method: 'Runtime.evaluate',
                params: { expression: "await fetch('/')", replMode: true },
            }),
        ).forward;

        assert.match(JSON.parse(forwarded ?? '{}').params.expression, /^\(async \(\) => \{/);
        // WebKit answers with the promise: nothing goes to DevTools yet, an awaitPromise goes up.
        assert.equal(
            translator.fromUpstream(
                JSON.stringify({
                    id: 7,
                    result: {
                        result: { type: 'object', className: 'Promise', objectId: 'p1' },
                        wasThrown: false,
                    },
                }),
            ),
            null,
        );

        const [awaitCall] = sent as {
            id: number;
            method: string;
            params: { promiseObjectId: string };
        }[];

        assert.equal(awaitCall?.method, 'Runtime.awaitPromise');
        assert.equal(awaitCall?.params.promiseObjectId, 'p1');
        assert.deepEqual(
            JSON.parse(
                translator.fromUpstream(
                    JSON.stringify({
                        id: awaitCall?.id,
                        result: { result: { type: 'number', value: 200 }, wasThrown: false },
                    }),
                ) ?? '{}',
            ),
            { id: 7, result: { result: { type: 'number', value: 200 }, wasThrown: false } },
        );
    });

    it('a rejected promise reaches the Console as an exception; a command without await is left alone', () => {
        const sent: { id: number }[] = [];
        const translator = createIosDevtoolsTranslator({
            sendUpstream: (raw) => sent.push(JSON.parse(raw)),
        });

        translator.fromClient(
            JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: 'await p', replMode: true },
            }),
        );
        translator.fromUpstream(
            JSON.stringify({
                id: 1,
                result: { result: { type: 'object', objectId: 'p' }, wasThrown: false },
            }),
        );

        const reply = JSON.parse(
            translator.fromUpstream(
                JSON.stringify({
                    id: sent[0]?.id,
                    result: {
                        result: { type: 'object', subtype: 'error', description: 'Error: nope' },
                        wasThrown: true,
                    },
                }),
            ) ?? '{}',
        );

        assert.equal(reply.id, 1);
        assert.equal(reply.result.exceptionDetails.text, 'Uncaught');

        const plain = translator.fromClient(
            JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: { expression: '1 + 1', replMode: true },
            }),
        );

        assert.equal(JSON.parse(plain.forward ?? '{}').params.expression, '1 + 1');
    });
});
