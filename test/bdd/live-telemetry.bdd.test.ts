import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAdbRunner, forwardWebView } from '../../src/node/adb.ts';
import type { DevtoolsPage } from '../../src/node/cdp.ts';
import { diagnose } from '../../src/node/device.ts';
import { startOverride } from '../../src/node/override.ts';
import { createFakeCdp } from '../helpers/fake-cdp.ts';

const PAGE: DevtoolsPage = {
    id: 'page-1',
    type: 'page',
    url: 'https://stand.example.test/',
    title: 'App',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/page-1',
};

describe('Feature: Live device telemetry, multi-device selection, app pinning and Source Maps', () => {
    describe('Scenario: Console output, uncaught exceptions and failed network requests stream to terminal', () => {
        it('Given override started with telemetry enabled, When the page logs, throws, and hits a 500/network failure, Then formatted lines are emitted to log/error callbacks', async () => {
            const fake = createFakeCdp();
            const logs: string[] = [];
            const errors: string[] = [];

            const session = await startOverride({
                page: PAGE,
                remote: 'https://stand.example.test',
                local: 'http://localhost:5173',
                connect: async () => fake.cdp,
                fetchImpl: async () => new Response('ok'),
                telemetry: {
                    log: (line) => logs.push(line),
                    error: (line) => errors.push(line),
                },
                logger: { request: () => undefined, error: () => undefined },
            });

            fake.emit('Runtime.consoleAPICalled', {
                type: 'log',
                args: [
                    { type: 'string', value: 'hydrated' },
                    { type: 'number', value: 42 },
                ],
                stackTrace: {
                    callFrames: [
                        {
                            url: 'https://stand.example.test/src/main.tsx',
                            lineNumber: 9,
                            columnNumber: 4,
                        },
                    ],
                },
            });

            fake.emit('Runtime.consoleAPICalled', {
                type: 'error',
                args: [{ type: 'string', value: 'bridge missing' }],
            });

            fake.emit('Runtime.exceptionThrown', {
                exceptionDetails: {
                    text: 'Uncaught',
                    url: 'https://stand.example.test/src/cart.tsx',
                    lineNumber: 17,
                    columnNumber: 2,
                    exception: { description: 'ReferenceError: nativeBridge is not defined' },
                },
            });

            fake.emit('Network.requestWillBeSent', {
                requestId: 'r-500',
                request: { url: 'https://api.example.test/orders', method: 'POST' },
            });
            fake.emit('Network.responseReceived', {
                requestId: 'r-500',
                response: { url: 'https://api.example.test/orders', status: 500 },
            });

            fake.emit('Network.requestWillBeSent', {
                requestId: 'r-fail',
                request: { url: 'https://api.example.test/profile', method: 'GET' },
            });
            fake.emit('Network.loadingFailed', {
                requestId: 'r-fail',
                errorText: 'net::ERR_CONNECTION_REFUSED',
            });

            assert.ok(
                logs.some(
                    (line) =>
                        line.includes('[console.log]') &&
                        line.includes('hydrated 42') &&
                        line.includes('/src/main.tsx:10:5'),
                ),
            );
            assert.ok(
                errors.some(
                    (line) => line.includes('[console.error]') && line.includes('bridge missing'),
                ),
            );
            assert.ok(
                errors.some(
                    (line) =>
                        line.includes('[exception]') &&
                        line.includes('ReferenceError: nativeBridge is not defined') &&
                        line.includes('/src/cart.tsx:18:3'),
                ),
            );
            assert.ok(
                errors.some(
                    (line) =>
                        line.includes('[network]') &&
                        line.includes('500 POST https://api.example.test/orders'),
                ),
            );
            assert.ok(
                errors.some(
                    (line) =>
                        line.includes('[network]') &&
                        line.includes('FAIL GET https://api.example.test/profile') &&
                        line.includes('ERR_CONNECTION_REFUSED'),
                ),
            );

            session.close();
        });
    });

    describe('Scenario: Multiple Android phones connected simultaneously', () => {
        it('Given two online phones, When --serial is omitted diagnose asks to choose, And when --serial is passed commands target only that phone', () => {
            const calls: string[] = [];
            const fakeRun = (args: string[]) => {
                const key = args.join(' ');

                calls.push(key);
                if (key === 'devices') {
                    return 'List of devices attached\npixel-1\tdevice\nsamsung-2\tdevice\n';
                }
                if (key === '-s samsung-2 shell dumpsys window') {
                    return '  mCurrentFocus=Window{1 u0 com.example.app/.Main}';
                }
                if (key === '-s samsung-2 shell cat /proc/net/unix') {
                    return '@webview_devtools_remote_500\n';
                }
                if (key === '-s samsung-2 shell ps -A -o PID,NAME') {
                    return 'PID NAME\n500 com.example.app\n';
                }

                return '';
            };

            const hintWithoutSerial = diagnose(9223, fakeRun);

            assert.match(hintWithoutSerial, /Multiple phones/);
            assert.match(hintWithoutSerial, /pixel-1/);
            assert.match(hintWithoutSerial, /samsung-2/);
            assert.match(hintWithoutSerial, /--serial/);

            const hintWithSerial = diagnose(9223, fakeRun, { serial: 'samsung-2' });

            assert.match(hintWithSerial, /webview_devtools_remote_500/);
            assert.ok(
                calls.includes(
                    '-s samsung-2 forward tcp:9223 localabstract:webview_devtools_remote_500',
                ),
            );
        });
    });

    describe('Scenario: Pinning WebView discovery to a specific Android package (--app)', () => {
        it('Given debug and release apps running, When --app com.example.debug is passed, Then debug socket wins even if release is focused, and missing app reports clearly', () => {
            const fakeRun = (args: string[]) => {
                const key = args.join(' ');

                if (key === 'devices') return 'List of devices attached\npixel-1\tdevice\n';
                if (key === 'shell dumpsys window') {
                    return '  mCurrentFocus=Window{1 u0 com.example.release/.Main}';
                }
                if (key === 'shell cat /proc/net/unix') {
                    return '@webview_devtools_remote_100\n@webview_devtools_remote_200\n';
                }
                if (key === 'shell ps -A -o PID,NAME') {
                    return 'PID NAME\n100 com.example.debug\n200 com.example.release\n';
                }

                return '';
            };

            const picked = forwardWebView(9223, createAdbRunner(undefined, fakeRun), {
                app: 'com.example.debug',
            });

            assert.equal(picked, 'webview_devtools_remote_100');

            const missingHint = diagnose(9223, fakeRun, { app: 'com.example.other' });

            assert.match(missingHint, /com\.example\.other/);
        });
    });

    describe('Scenario: Source Maps pass through local override intact', () => {
        it('Given a JS bundle with SourceMap header and its .map payload, When fetched via override, Then both SourceMap header and JSON map body are preserved', async () => {
            const sourceMapBody = JSON.stringify({
                version: 3,
                sources: ['src/App.tsx'],
                mappings: 'AAAA',
            });
            const fake = createFakeCdp();

            const session = await startOverride({
                page: PAGE,
                remote: 'https://stand.example.test',
                local: 'http://localhost:5173',
                connect: async () => fake.cdp,
                fetchImpl: async (input) => {
                    const url = String(input);

                    if (url.endsWith('.map')) {
                        return new Response(sourceMapBody, {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        });
                    }

                    return new Response('console.log(1);', {
                        status: 200,
                        headers: {
                            'content-type': 'application/javascript',
                            sourcemap: '/assets/app.js.map',
                        },
                    });
                },
                logger: { request: () => undefined, error: () => undefined },
            });

            fake.emit('Fetch.requestPaused', {
                requestId: 'req-js',
                request: {
                    url: 'https://stand.example.test/assets/app.js',
                    method: 'GET',
                    headers: {},
                },
            });

            const jsFulfill = await fake.waitForCall('Fetch.fulfillRequest');
            const jsParams = jsFulfill.params as {
                responseHeaders: { name: string; value: string }[];
            };

            assert.ok(
                jsParams.responseHeaders.some(
                    (h) => h.name === 'sourcemap' && h.value === '/assets/app.js.map',
                ),
            );

            fake.calls.length = 0;
            fake.emit('Fetch.requestPaused', {
                requestId: 'req-map',
                request: {
                    url: 'https://stand.example.test/assets/app.js.map',
                    method: 'GET',
                    headers: {},
                },
            });

            const mapFulfill = await fake.waitForCall('Fetch.fulfillRequest');
            const mapParams = mapFulfill.params as { body: string };

            assert.equal(Buffer.from(mapParams.body, 'base64').toString('utf8'), sourceMapBody);

            session.close();
        });
    });
});
