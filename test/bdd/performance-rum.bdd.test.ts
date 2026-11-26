import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceDriver, InspectorSession } from '../../src/node/drivers/types.ts';
import {
    checkBudgets,
    measureVitals,
    parseBudgets,
    toMarkdown,
} from '../../src/node/vitals-lab.ts';

describe('Feature: CI Performance Budgets, Cross-platform Lab Vitals & Production RUM Context', () => {
    describe('Scenario: Lab vitals enforces CI budgets and reports violations clearly', () => {
        it('Given budget lcp=2000,cls=0.1, When measured LCP is 2800ms and CLS is 0.05, Then checkBudgets returns the LCP violation only', () => {
            const budgets = parseBudgets('lcp=2000,cls=0.1');
            const violations = checkBudgets(
                {
                    origin: 'https://stand.example.test',
                    device: 'Android WebView',
                    options: { runs: 3, cold: true, interact: 0 },
                    rows: [
                        {
                            path: '/checkout',
                            LCP: 2800,
                            FCP: 900,
                            CLS: 0.05,
                            INP: null,
                            TTFB: 300,
                            lcpElement: 'img.hero',
                            shifts: [],
                        },
                    ],
                },
                budgets,
            );

            assert.deepEqual(violations, [
                { path: '/checkout', metric: 'LCP', actual: 2800, limit: 2000 },
            ]);
        });
    });

    describe('Scenario: iOS lab vitals marks unsupported WebKit metrics as n/a and captures Long Tasks & marks', () => {
        it('Given an iOS driver returning TTFB, FCP, Long Tasks and custom marks, When measureVitals runs, Then Markdown shows n/a for unsupported CLS/INP/LCP and includes Long Tasks', async () => {
            const target = {
                id: 'ios-1',
                platform: 'ios' as const,
                type: 'page',
                url: 'https://stand.example.test/',
                title: 'Shop',
                debuggerUrl: 'ws://fake/ios/1',
            };
            const driver: DeviceDriver = {
                platform: 'ios',
                listDevices: () => [{ id: 'u1', platform: 'ios', state: 'connected' }],
                isAvailable: () => true,
                diagnose: async () => 'ready',
                doctor: async () => ({ platform: 'ios', checks: [], targets: [target] }),
                listTargets: async () => [target],
                waitForTarget: async () => target,
                getDeviceDescription: async () => 'iPhone 16 Pro (iOS WKWebView)',
                connectInspector: async (): Promise<InspectorSession> => ({
                    platform: 'ios',
                    capabilities: { lcp: false, cls: false, inp: false, cdpFetchOverride: false },
                    addInitScript: async () => undefined,
                    setCacheDisabled: async () => undefined,
                    navigate: async () => undefined,
                    reload: async () => undefined,
                    evaluate: async <T>() =>
                        JSON.stringify({
                            lcp: null,
                            fcp: 520,
                            cls: null,
                            inp: null,
                            ttfb: 140,
                            longTasksCount: 2,
                            longTasksTotalMs: 135,
                            marks: { bridge_ready: 88 },
                        }) as T,
                    close: () => undefined,
                    closed: Promise.resolve(),
                }),
            };

            const result = await measureVitals({
                driver,
                paths: ['/'],
                runs: 1,
                settleMs: 0,
                log: () => undefined,
            });

            assert.equal(result.rows[0]?.longTasks?.count, 2);
            assert.equal(result.rows[0]?.longTasks?.totalMs, 135);
            assert.deepEqual(result.rows[0]?.marks, { bridge_ready: 88 });

            const markdown = toMarkdown(result, new Date('2026-01-01T00:00:00Z'));

            assert.match(markdown, /⚪ n\/a/);
            assert.match(markdown, /2 \(135 ms\)/);
            assert.match(markdown, /bridge_ready=88 ms/);
        });
    });
});
