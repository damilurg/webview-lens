import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Cdp } from '../../src/node/cdp.ts';
import { createAndroidDriver } from '../../src/node/drivers/android.ts';
import { isNetworkThrottlePreset, measureVitals, toMarkdown } from '../../src/node/vitals-lab.ts';

describe('Feature: Lab Network/CPU Throttling & JS Heap Metrics', () => {
    describe('Scenario: Running vitals with --throttle slow-4g --cpu 4 applies CDP emulation, captures JS Heap, and resets cleanly in finally', () => {
        it('Given an Android driver with CDP, When measureVitals runs with throttle and cpu, Then Network.emulateNetworkConditions, Emulation.setCPUThrottlingRate and Performance.getMetrics are invoked and reset afterward', async () => {
            assert.equal(isNetworkThrottlePreset('slow-4g'), true);
            assert.equal(isNetworkThrottlePreset('2g-invalid'), false);

            const calls: { method: string; params: unknown }[] = [];
            let triggerLoad: (() => void) | undefined;

            const fakeCdp: Cdp = {
                send: async <T>(method: string, params: object = {}) => {
                    calls.push({ method, params });
                    if (method === 'Page.navigate') triggerLoad?.();
                    if (method === 'Runtime.evaluate') {
                        return {
                            result: {
                                value: JSON.stringify({
                                    lcp: 1800,
                                    fcp: 950,
                                    cls: 0.02,
                                    inp: null,
                                    ttfb: 410,
                                }),
                            },
                        } as T;
                    }
                    if (method === 'Performance.getMetrics') {
                        return {
                            metrics: [
                                { name: 'Nodes', value: 420 },
                                { name: 'JSHeapUsedSize', value: 25 * 1024 * 1024 },
                            ],
                        } as T;
                    }

                    return {} as T;
                },
                on: () => () => undefined,
                once: <T>(method: string) =>
                    new Promise<T>((resolve) => {
                        if (method === 'Page.loadEventFired') {
                            triggerLoad = () => resolve({} as T);
                        }
                    }),
                close: () => undefined,
                closed: Promise.resolve(),
            };

            const driver = createAndroidDriver({
                findAdb: () => ({ adb: '/usr/bin/adb', checked: [] }),
                runAdb: () => '',
                listPages: async () => [
                    {
                        id: 'p1',
                        type: 'page',
                        url: 'https://stand.example.test/',
                        title: 'Home',
                        webSocketDebuggerUrl: 'ws://localhost:9223/devtools/page/p1',
                    },
                ],
                getVersion: async () => ({ 'User-Agent': 'Pixel 8 WebView' }),
                connectCdp: async () => fakeCdp,
            });

            const result = await measureVitals({
                driver,
                paths: ['/'],
                runs: 1,
                throttle: 'slow-4g',
                cpu: 4,
                settleMs: 0,
                log: () => undefined,
            });

            const netCalls = calls.filter((c) => c.method === 'Network.emulateNetworkConditions');
            const cpuCalls = calls.filter((c) => c.method === 'Emulation.setCPUThrottlingRate');

            assert.equal(netCalls.length, 2);
            assert.equal((netCalls[0]?.params as { latency: number }).latency, 150);
            assert.equal(
                (netCalls[1]?.params as { downloadThroughput: number }).downloadThroughput,
                -1,
            );

            assert.deepEqual(
                cpuCalls.map((c) => c.params),
                [{ rate: 4 }, { rate: 1 }],
            );

            assert.equal(result.rows[0]?.jsHeapMb, 25);

            const md = toMarkdown(result, new Date('2026-01-01T00:00:00Z'));

            assert.match(md, /JS Heap/);
            assert.match(md, /25\.0 MB/);
        });
    });
});
