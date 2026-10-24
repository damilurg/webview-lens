import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceDriver, InspectorSession } from '../../src/node/drivers/types.ts';
import {
    checkBudgets,
    measureVitals,
    parseBudgets,
    toMarkdown,
} from '../../src/node/vitals-lab.ts';
import {
    createTimingReporter,
    createVitalsReporter,
    detectWebViewEnv,
} from '../../src/rum/index.ts';
import {
    createTimingsHandler,
    createVitalsHandler,
    type TimingMetric,
    type VitalMetric,
} from '../../src/rum/server.ts';

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

    describe('Scenario: Production RUM carries WebView context tags and custom bridge timings', () => {
        it('Given Android WebView UA and custom context, When vitals and custom timings are reported, Then server handlers validate and deliver checked context and timings', async () => {
            const env = detectWebViewEnv(
                'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
            );

            assert.equal(env, 'android-webview');

            const vitals: VitalMetric[] = [];
            const timings: TimingMetric[] = [];
            const vitalsHandler = createVitalsHandler({
                onMetric: (m) => void vitals.push(m),
            });
            const timingsHandler = createTimingsHandler({
                onTiming: (t) => void timings.push(t),
            });

            const pending: Promise<Response>[] = [];
            const sendTo =
                (handler: (req: Request) => Promise<Response>) =>
                (endpoint: string, body: string) => {
                    pending.push(
                        handler(
                            new Request(`https://app.example.test${endpoint}`, {
                                method: 'POST',
                                body,
                                headers: { 'content-type': 'application/json' },
                            }),
                        ),
                    );
                };

            const reportVital = createVitalsReporter({
                path: () => '/checkout/:step',
                context: () => ({ appVersion: '5.12.0', env }),
                transport: sendTo(vitalsHandler),
            });
            const reportTiming = createTimingReporter({
                path: () => '/checkout/:step',
                context: () => ({ appVersion: '5.12.0', env }),
                transport: sendTo(timingsHandler),
            });

            reportVital({ name: 'LCP', value: 1850, rating: 'good' });
            reportTiming('bridge_init', 42.5);

            const responses = await Promise.all(pending);

            assert.deepEqual(
                responses.map((r) => r.status),
                [204, 204],
            );
            assert.deepEqual(vitals, [
                {
                    name: 'LCP',
                    value: 1850,
                    rating: 'good',
                    path: '/checkout/:step',
                    context: { appVersion: '5.12.0', env: 'android-webview' },
                },
            ]);
            assert.deepEqual(timings, [
                {
                    name: 'bridge_init',
                    duration: 42.5,
                    path: '/checkout/:step',
                    context: { appVersion: '5.12.0', env: 'android-webview' },
                },
            ]);
        });
    });
});
