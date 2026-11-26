import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    translateCdpToWip,
    translateWipEventToCdp,
    translateWipResultToCdp,
} from '../src/node/drivers/ios/wip-cdp-bridge.ts';
import { createIosDevtoolsTranslator } from '../src/node/drivers/ios/devtools-bridge.ts';

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
            exceptionDetails: {
                text: 'ReferenceError: x',
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
