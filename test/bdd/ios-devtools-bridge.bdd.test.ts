import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createIosDevtoolsTranslator } from '../../src/node/drivers/ios/devtools-bridge.ts';
import { ensureIwdp } from '../../src/node/drivers/ios/iwdp.ts';

describe('Feature: Cross-platform Chrome DevTools bridge for iOS WKWebView', () => {
    describe('Scenario: Translating a live Chrome DevTools session over WIP ↔ CDP', () => {
        it('Given Chrome DevTools connects to an iOS WKWebView, When CDP commands and WIP events flow, Then Chromium-only commands auto-ack, supported commands translate, and WebKit responses/events arrive in CDP format', () => {
            const translator = createIosDevtoolsTranslator();

            // 1. Chromium-only command immediately returns empty success result without bothering WebKit.
            const autoAck = translator.fromClient(
                JSON.stringify({ id: 1, method: 'Autofill.enable', params: {} }),
            );

            assert.equal(autoAck.forward, undefined);
            assert.deepEqual(JSON.parse(autoAck.immediateResponse ?? '{}'), { id: 1, result: {} });

            // 2. Supported CDP command translates to WebKit Inspector Protocol.
            const cacheCmd = translator.fromClient(
                JSON.stringify({
                    id: 2,
                    method: 'Network.setCacheDisabled',
                    params: { cacheDisabled: true },
                }),
            );

            assert.deepEqual(JSON.parse(cacheCmd.forward ?? '{}'), {
                id: 2,
                method: 'Network.setResourceCachingDisabled',
                params: { disabled: true },
            });

            // 3. Runtime.evaluate with wasThrown: true maps to CDP exceptionDetails.
            const evalCmd = translator.fromClient(
                JSON.stringify({
                    id: 3,
                    method: 'Runtime.evaluate',
                    params: { expression: 'missingVar', returnByValue: true },
                }),
            );

            assert.equal(JSON.parse(evalCmd.forward ?? '{}').method, 'Runtime.evaluate');

            const evalReply = translator.fromUpstream(
                JSON.stringify({
                    id: 3,
                    result: {
                        result: {
                            type: 'object',
                            subtype: 'error',
                            description: 'ReferenceError: missingVar',
                        },
                        wasThrown: true,
                    },
                }),
            );

            assert.deepEqual(JSON.parse(evalReply ?? '{}'), {
                id: 3,
                result: {
                    result: {
                        type: 'object',
                        subtype: 'error',
                        description: 'ReferenceError: missingVar',
                    },
                    exceptionDetails: {
                        text: 'ReferenceError: missingVar',
                        exception: {
                            type: 'object',
                            subtype: 'error',
                            description: 'ReferenceError: missingVar',
                        },
                    },
                },
            });

            // 4. WebKit Console.messageAdded translates into CDP Runtime.consoleAPICalled.
            const consoleEvent = translator.fromUpstream(
                JSON.stringify({
                    method: 'Console.messageAdded',
                    params: {
                        message: {
                            level: 'error',
                            text: 'boom on iphone',
                            url: 'https://stand.example.test/app.js',
                            line: 25,
                            column: 8,
                            timestamp: 1_700_000_000,
                        },
                    },
                }),
            );

            assert.deepEqual(JSON.parse(consoleEvent ?? '{}'), {
                method: 'Runtime.consoleAPICalled',
                params: {
                    type: 'error',
                    args: [{ type: 'string', value: 'boom on iphone' }],
                    timestamp: 1_700_000_000_000,
                    stackTrace: {
                        callFrames: [
                            {
                                url: 'https://stand.example.test/app.js',
                                lineNumber: 24,
                                columnNumber: 7,
                            },
                        ],
                    },
                },
            });
        });
    });

    describe('Scenario: Auto-starting ios_webkit_debug_proxy when installed but not running', () => {
        it('Given IWDP is not listening on :9221, When ensureIwdp runs, Then it spawns IWDP and waits until :9221 answers', async () => {
            let calls = 0;
            let stopped = false;
            const spawned: string[] = [];

            const proc = await ensureIwdp({
                controlPort: 9221,
                pollIntervalMs: 5,
                timeoutMs: 500,
                findIwdp: () => ({ iwdp: '/opt/homebrew/bin/ios_webkit_debug_proxy', checked: [] }),
                listIwdpDevices: async () => {
                    calls += 1;

                    return calls >= 2 ? [] : null;
                },
                spawnIwdp: (bin, args) => {
                    spawned.push([bin, ...args].join(' '));

                    return {
                        exitCode: null,
                        stop: () => {
                            stopped = true;
                        },
                    };
                },
                log: () => undefined,
            });

            assert.ok(proc);
            assert.deepEqual(spawned, ['/opt/homebrew/bin/ios_webkit_debug_proxy']);
            proc.stop();
            assert.equal(stopped, true);
        });

        it('Given IWDP is already running, When ensureIwdp runs, Then no duplicate process is spawned', async () => {
            let spawnCount = 0;
            const proc = await ensureIwdp({
                controlPort: 9221,
                listIwdpDevices: async () => [],
                spawnIwdp: () => {
                    spawnCount += 1;

                    return { exitCode: null, stop: () => undefined };
                },
                log: () => undefined,
            });

            assert.equal(proc, undefined);
            assert.equal(spawnCount, 0);
        });
    });
});
