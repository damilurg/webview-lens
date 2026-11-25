import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    translateCdpToWip,
    translateWipEventToCdp,
    translateWipResultToCdp,
} from '../src/node/drivers/ios/wip-cdp-bridge.ts';

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
