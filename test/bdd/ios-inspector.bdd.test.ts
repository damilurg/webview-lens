import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Cdp, onceVia } from '../../src/node/cdp.ts';
import { createIosDriver } from '../../src/node/drivers/ios/index.ts';
import { resolveDriver } from '../../src/node/drivers/registry.ts';
import type { DeviceDriver } from '../../src/node/drivers/types.ts';

interface FakeWipCall {
    method: string;
    params: unknown;
}

const createFakeWipSocket = () => {
    const calls: FakeWipCall[] = [];
    const listeners = new Map<string, Set<(params: unknown) => void>>();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const socket: Cdp = {
        send: async <T>(method: string, params: object = {}) => {
            calls.push({ method, params });
            if (method === 'Runtime.evaluate') {
                return { result: { type: 'string', value: 'hello-from-wkwebview' } } as T;
            }

            return {} as T;
        },
        on: (method: string, listener: (params: unknown) => void) => {
            const set = listeners.get(method) ?? new Set();

            set.add(listener);
            listeners.set(method, set);

            return () => set.delete(listener);
        },
        once: (method: string) => onceVia(socket.on)(method),
        close: () => resolveClosed(),
        closed,
    };

    const emit = (method: string, params: unknown) => {
        for (const fn of listeners.get(method) ?? []) fn(params);
    };

    return { socket, calls, emit };
};

describe('Feature: Cross-platform iOS USB Discovery & WKWebView Inspector (macOS + Windows)', () => {
    describe('Scenario: doctor on Windows without Apple Mobile Device Service gives actionable setup guidance', () => {
        it('Given win32 and usbmuxd port 27015 refused, When ios driver doctor runs, Then it reports missing Apple Devices / iTunes service', async () => {
            const driver = createIosDriver({
                platform: 'win32',
                listIosDevices: async () => ({
                    available: false,
                    devices: [],
                    error: 'ECONNREFUSED',
                }),
                findIwdp: () => ({ iwdp: undefined, checked: ['PATH'] }),
            });

            const report = await driver.doctor();

            assert.equal(report.platform, 'ios');
            assert.equal(report.checks[0]?.ok, false);
            assert.match(report.checks[0]?.message ?? '', /Apple|iTunes|27015/i);
        });
    });

    describe('Scenario: doctor discovers a connected iPhone and its inspectable WKWebView pages', () => {
        it('Given usbmuxd lists an iPhone and IWDP exposes a WKWebView page, When doctor runs, Then all checks pass and the target is returned', async () => {
            const driver = createIosDriver({
                platform: 'darwin',
                listIosDevices: async () => ({
                    available: true,
                    devices: [
                        {
                            deviceId: 1,
                            udid: '00008110-001A2B3C',
                            connectionType: 'USB',
                            productId: 4776,
                        },
                    ],
                }),
                findIwdp: () => ({ iwdp: '/opt/homebrew/bin/ios_webkit_debug_proxy', checked: [] }),
                listIwdpDevices: async () => [
                    {
                        deviceId: '00008110-001A2B3C',
                        deviceName: 'iPhone 16 Pro',
                        url: 'localhost:9222',
                    },
                ],
                listIwdpPages: async () => [
                    {
                        id: 'page-ios-1',
                        title: 'Checkout',
                        url: 'https://stand.example.test/checkout',
                        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/1',
                    },
                ],
            });

            const report = await driver.doctor();

            assert.equal(report.platform, 'ios');
            assert.ok(report.checks.every((c) => c.ok));
            assert.equal(report.targets.length, 1);
            assert.equal(report.targets[0]?.platform, 'ios');
            assert.equal(report.targets[0]?.url, 'https://stand.example.test/checkout');
            assert.equal(await driver.getDeviceDescription(), 'iPhone 16 Pro (iOS WKWebView)');
        });
    });

    describe('Scenario: IosInspectorSession translates WIP ↔ CDP commands and streams live telemetry', () => {
        it('Given a connected WKWebView WIP socket, When InspectorSession runs evaluate, init script, cache disable and telemetry, Then WIP methods are sent and WebKit events stream as formatted logs', async () => {
            const fakeWip = createFakeWipSocket();
            const driver = createIosDriver({
                connectWip: async () => fakeWip.socket,
            });

            const session = await driver.connectInspector({
                id: 'page-ios-1',
                platform: 'ios',
                type: 'page',
                url: 'https://stand.example.test/',
                title: 'App',
                debuggerUrl: 'ws://localhost:9222/devtools/page/1',
            });

            assert.equal(session.platform, 'ios');
            assert.equal(session.capabilities.cdpFetchOverride, false);

            await session.setCacheDisabled(true);
            await session.addInitScript('window.__boot = true;');
            const result = await session.evaluate('"hello"');

            assert.equal(result, 'hello-from-wkwebview');
            assert.ok(
                fakeWip.calls.some(
                    (c) =>
                        c.method === 'Network.setResourceCachingDisabled' &&
                        (c.params as { disabled: boolean }).disabled === true,
                ),
            );
            assert.ok(
                fakeWip.calls.some(
                    (c) =>
                        c.method === 'Page.setBootstrapScript' &&
                        (c.params as { source: string }).source === 'window.__boot = true;',
                ),
            );

            const logs: string[] = [];
            const errors: string[] = [];
            const detach = await session.attachTelemetry?.({
                log: (l) => logs.push(l),
                error: (e) => errors.push(e),
            });

            fakeWip.emit('Console.messageAdded', {
                message: {
                    source: 'console-api',
                    level: 'log',
                    text: 'mounted on ios',
                    url: 'https://stand.example.test/app.js',
                    line: 12,
                    column: 3,
                },
            });
            fakeWip.emit('Network.requestWillBeSent', {
                requestId: 'ios-req-1',
                request: { url: 'https://api.example.test/me', method: 'GET' },
            });
            fakeWip.emit('Network.loadingFailed', {
                requestId: 'ios-req-1',
                localizedDescription: 'The Internet connection appears to be offline.',
            });

            assert.ok(
                logs.some(
                    (line) =>
                        line.includes('[console.log]') &&
                        line.includes('mounted on ios') &&
                        line.includes('/app.js:12:3'),
                ),
            );
            assert.ok(
                errors.some(
                    (line) =>
                        line.includes('[network]') &&
                        line.includes('FAIL GET https://api.example.test/me') &&
                        line.includes('offline'),
                ),
            );

            detach?.();
            session.close();
        });
    });

    describe('Scenario: Auto driver resolution picks iOS when only an iPhone is connected', () => {
        it('Given Android unavailable and iOS connected via usbmuxd, When resolveDriver("auto") runs, Then iOS driver wins', async () => {
            const androidOffline = {
                platform: 'android',
                isAvailable: () => false,
                listDevices: () => [],
            } as unknown as DeviceDriver;
            const iosOnline = createIosDriver({
                listIosDevices: async () => ({
                    available: true,
                    devices: [{ deviceId: 2, udid: 'udid-iphone', connectionType: 'USB' }],
                }),
            });

            const selected = await resolveDriver('auto', [androidOffline, iosOnline]);

            assert.equal(selected.platform, 'ios');
        });
    });
});

describe('Scenario: a WebView behind another screen never answers (seen on the test iPhone)', () => {
    it('Given a page socket that never replies, When connectInspector runs, Then it fails in time, names the reason and closes the socket', async () => {
        let closed = false;
        const silent: Cdp = {
            send: () => new Promise(() => undefined),
            on: () => () => undefined,
            once: () => new Promise(() => undefined),
            close: () => {
                closed = true;
            },
            closed: new Promise(() => undefined),
        };
        const driver = createIosDriver({
            platform: 'darwin',
            connectWip: async () => silent,
            connectTimeoutMs: 30,
        });
        const started = Date.now();

        await assert.rejects(
            driver.connectInspector({
                id: 'ios-page-1',
                platform: 'ios',
                type: 'page',
                title: 'Shop',
                url: 'https://stand.test/',
                debuggerUrl: 'ws://localhost:9222/devtools/page/1',
            }),
            /did not answer in 0\.03 s: the iPhone locked, a WebView behind another screen/,
        );
        assert.ok(Date.now() - started < 1000);
        assert.equal(closed, true);
    });
});
