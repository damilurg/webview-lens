import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Cdp } from '../../src/node/cdp.ts';
import { createAndroidDriver } from '../../src/node/drivers/android.ts';
import { resolveDriver } from '../../src/node/drivers/registry.ts';
import type {
    ConnectedDevice,
    DeviceDriver,
    InspectableTarget,
    InspectorSession,
} from '../../src/node/drivers/types.ts';
import { measureVitals, toMarkdown } from '../../src/node/vitals-lab.ts';

const createFakeDriver = (
    platform: 'android' | 'ios',
    devices: ConnectedDevice[],
    runsByPath: Record<string, string[]> = {},
): { driver: DeviceDriver; navigated: string[]; cacheStates: boolean[] } => {
    const navigated: string[] = [];
    const cacheStates: boolean[] = [];
    const counters = new Map<string, number>();

    const target: InspectableTarget = {
        id: `${platform}-target-1`,
        platform,
        type: 'page',
        url: 'https://stand.example.test/',
        title: 'Home',
        debuggerUrl: `ws://fake/${platform}/1`,
    };

    const driver: DeviceDriver = {
        platform,
        listDevices: () => devices,
        isAvailable: () => devices.some((d) => d.state === 'device' || d.state === 'connected'),
        diagnose: async () => `${platform} ready`,
        doctor: async () => ({
            platform,
            checks: [{ ok: true, message: `${platform} ok` }],
            targets: [target],
        }),
        listTargets: async () => [target],
        waitForTarget: async (predicate) => {
            if (!predicate(target)) throw new Error('Target did not match predicate');

            return target;
        },
        getDeviceDescription: async () =>
            platform === 'ios' ? 'iPhone WKWebView' : 'Android WebView',
        connectInspector: async (): Promise<InspectorSession> => {
            let currentPath = '/';
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolve) => {
                resolveClosed = resolve;
            });

            return {
                platform,
                capabilities:
                    platform === 'ios'
                        ? { lcp: false, cls: false, inp: false, cdpFetchOverride: false }
                        : { lcp: true, cls: true, inp: true, cdpFetchOverride: true },
                addInitScript: async () => undefined,
                setCacheDisabled: async (disabled) => {
                    cacheStates.push(disabled);
                },
                navigate: async (url) => {
                    currentPath = new URL(url).pathname;
                    navigated.push(currentPath);
                },
                reload: async () => undefined,
                evaluate: async <T>() => {
                    const list = runsByPath[currentPath] ?? [];
                    const idx = counters.get(currentPath) ?? 0;

                    counters.set(currentPath, idx + 1);

                    return (list[idx] ?? 'null') as T;
                },
                close: () => resolveClosed(),
                closed,
            };
        },
    };

    return { driver, navigated, cacheStates };
};

describe('Feature: Platform-agnostic DeviceDriver architecture', () => {
    describe('Scenario: measureVitals runs end-to-end on any DeviceDriver without ADB or CDP', () => {
        it('Given a FakeDriver returning lab metrics across 3 runs, When measureVitals executes, Then medians and Markdown report are produced cleanly', async () => {
            const { driver, navigated, cacheStates } = createFakeDriver(
                'ios',
                [{ id: 'udid-1', platform: 'ios', state: 'connected' }],
                {
                    '/': [
                        JSON.stringify({ lcp: null, fcp: 600, cls: null, inp: null, ttfb: 180 }),
                        JSON.stringify({ lcp: null, fcp: 700, cls: null, inp: null, ttfb: 200 }),
                        JSON.stringify({ lcp: null, fcp: 650, cls: null, inp: null, ttfb: 190 }),
                    ],
                },
            );

            const result = await measureVitals({
                driver,
                paths: ['/'],
                runs: 3,
                cold: true,
                settleMs: 0,
                log: () => undefined,
            });

            assert.equal(result.device, 'iPhone WKWebView');
            assert.deepEqual(navigated, ['/', '/', '/']);
            assert.deepEqual(cacheStates, [true, false]);
            assert.equal(result.rows[0]?.FCP, 650);
            assert.equal(result.rows[0]?.TTFB, 190);
            assert.equal(result.rows[0]?.LCP, null);

            const md = toMarkdown(result, new Date('2026-01-01T00:00:00Z'));

            assert.match(md, /iPhone WKWebView/);
            assert.match(md, /🟢 650 ms/);
            assert.match(md, /🟢 190 ms/);
        });
    });

    describe('Scenario: Platform auto-resolution picks the connected device driver', () => {
        it('Given Android has no device and iOS has a connected phone, When resolveDriver("auto") runs, Then iOS driver is selected', async () => {
            const android = createFakeDriver('android', []).driver;
            const ios = createFakeDriver('ios', [
                { id: 'udid-42', platform: 'ios', state: 'connected' },
            ]).driver;

            const chosenAuto = await resolveDriver('auto', [android, ios]);
            const chosenAndroid = await resolveDriver('android', [android, ios]);

            assert.equal(chosenAuto.platform, 'ios');
            assert.equal(chosenAndroid.platform, 'android');
        });
    });

    describe('Scenario: AndroidDriver bridges ADB & CDP behind DeviceDriver contract', () => {
        it('Given injected fake adb and cdp, When doctor and connectInspector run, Then AndroidDriver returns structured checks and executes inspector commands', async () => {
            const sent: string[] = [];
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolve) => {
                resolveClosed = resolve;
            });
            const fakeCdp: Cdp = {
                send: async <T>(method: string) => {
                    sent.push(method);
                    if (method === 'Runtime.evaluate') {
                        return { result: { value: '42' } } as T;
                    }

                    return {} as T;
                },
                on: () => () => undefined,
                once: async <T>() => ({}) as T,
                close: () => resolveClosed(),
                closed,
            };

            const driver = createAndroidDriver({
                findAdb: () => ({ adb: '/usr/bin/adb', checked: [] }),
                runAdb: (args) => {
                    const key = args.join(' ');

                    if (key === 'devices') return 'List of devices attached\npixel-1\tdevice\n';
                    if (key === 'shell dumpsys window') {
                        return '  mCurrentFocus=Window{1 u0 com.example.app/.Main}';
                    }
                    if (key === 'shell cat /proc/net/unix') {
                        return '@webview_devtools_remote_777\n';
                    }

                    return '';
                },
                listPages: async () => [
                    {
                        id: 'p1',
                        type: 'page',
                        url: 'https://stand.example.test/',
                        title: 'Stand',
                        webSocketDebuggerUrl: 'ws://localhost:9223/devtools/page/p1',
                    },
                ],
                getVersion: async () => ({ 'User-Agent': 'Pixel WebView' }),
                connectCdp: async () => fakeCdp,
            });

            const report = await driver.doctor({ port: 9223 });

            assert.equal(report.platform, 'android');
            assert.ok(report.checks.every((c) => c.ok));
            assert.equal(report.targets.length, 1);

            const session = await driver.connectInspector(report.targets[0]!);
            const evaluated = await session.evaluate<string>('1+1');

            assert.equal(evaluated, '42');
            assert.ok(sent.includes('Page.enable'));
            assert.ok(sent.includes('Network.enable'));
            assert.ok(sent.includes('Runtime.evaluate'));
            session.close();
        });
    });
});
