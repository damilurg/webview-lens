import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { generateRootCa } from '../src/node/drivers/ios/certs.ts';
import { enableIfSupported } from '../src/node/drivers/ios/index.ts';
import { describeIosDevices } from '../src/node/drivers/ios/usbmux.ts';
import { translateCdpToWip } from '../src/node/drivers/ios/wip-cdp-bridge.ts';
import { COLLECTOR, measureVitals } from '../src/node/vitals-lab.ts';
import { createIosDevtoolsTranslator } from '../src/node/drivers/ios/devtools-bridge.ts';
import {
    describeFetchError,
    isPrivateNetworkAddress,
    startIosMitmProxy,
} from '../src/node/drivers/ios/mitm-proxy.ts';
import { pickPage } from '../src/node/cdp.ts';
import { bridgeShim, startOverride } from '../src/node/override.ts';
import { buildWebSocketAcceptResponse } from '../src/node/ws-server.ts';
import {
    createRumAggregator,
    createVitalsHandler,
    type NodeIncomingMessage,
    type NodeServerResponse,
    toNodeHandler,
    toPrometheusText,
} from '../src/rum/server.ts';
import { createFakeCdp } from './helpers/fake-cdp.ts';

const PAGE = {
    id: 'p1',
    type: 'page',
    url: 'https://stand.example.test/',
    title: 'Stand',
    webSocketDebuggerUrl: 'ws://fake',
};

describe('override WebSocket bridge binding', () => {
    it('ignores malformed payloads and refuses sockets outside the stand origin / HMR ports', async () => {
        const fake = createFakeCdp();

        await startOverride({
            page: PAGE,
            remote: 'https://stand.example.test',
            local: 'http://localhost:3000',
            connect: async () => fake.cdp,
            fetchImpl: async () => new Response(''),
            logger: { request: () => undefined, error: () => undefined },
        });

        const name = '__webviewLensWsSend';

        assert.doesNotThrow(() =>
            fake.emit('Runtime.bindingCalled', { name, payload: '{not json' }),
        );

        fake.emit('Runtime.bindingCalled', {
            name,
            payload: JSON.stringify({ sid: 7, type: 'open', url: 'http://127.0.0.1:6379/' }),
        });

        const calls = await fake.waitForCalls('Runtime.evaluate', 3);
        const expressions = calls.map((c) =>
            String((c.params as { expression?: string }).expression),
        );

        assert.ok(expressions.some((e) => e.includes('(7, "error"')));
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

describe('toNodeHandler error handling', () => {
    it('answers 500 instead of rejecting when the callback throws', async () => {
        const handler = toNodeHandler(
            createVitalsHandler({
                onMetric: () => {
                    throw new Error('storage down');
                },
            }),
        );
        let status = 0;
        const req: NodeIncomingMessage = {
            method: 'POST',
            url: '/api/vitals',
            headers: { host: 'app.example.test', 'content-type': 'application/json' },
            async *[Symbol.asyncIterator]() {
                yield JSON.stringify({ name: 'LCP', value: 1200, rating: 'good', path: '/' });
            },
        };
        const res: NodeServerResponse = {
            get statusCode() {
                return status;
            },
            set statusCode(code: number) {
                status = code;
            },
            setHeader: () => undefined,
            end: () => undefined,
        };

        await handler(req, res);
        assert.equal(status, 500);
    });
});

describe('iOS MITM proxy plain HTTP', () => {
    it('forwards absolute-form http:// proxy requests instead of serving the CA landing page', async () => {
        const origin = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(`origin saw ${req.url} host=${req.headers.host}`);
        });

        await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));

        const originPort = (origin.address() as AddressInfo).port;
        const proxy = await startIosMitmProxy({
            remote: 'https://stand.example.test',
            local: 'http://127.0.0.1:1',
            port: 0,
            host: '127.0.0.1',
            ca: generateRootCa(),
            logger: { request: () => undefined, error: () => undefined },
        });

        try {
            const body = await new Promise<string>((resolve, reject) => {
                http.get(
                    {
                        host: '127.0.0.1',
                        port: proxy.port,
                        path: `http://127.0.0.1:${originPort}/hello?x=1`,
                    },
                    (res) => {
                        let text = '';

                        res.setEncoding('utf8');
                        res.on('data', (chunk: string) => (text += chunk));
                        res.on('end', () => resolve(text));
                    },
                ).on('error', reject);
            });

            assert.equal(body, `origin saw /hello?x=1 host=127.0.0.1:${originPort}`);
        } finally {
            await proxy.close();
            origin.close();
        }
    });
});

describe('iOS MITM proxy client restriction', () => {
    it('accepts loopback, private, link-local and CGNAT clients only', () => {
        for (const address of [
            '127.0.0.1',
            '10.1.2.3',
            '172.20.0.5',
            '192.168.1.10',
            '169.254.3.4',
            '100.64.0.1',
            '::1',
            'fe80::1',
            'fd12:3456::1',
            '::ffff:192.168.1.10',
        ]) {
            assert.equal(isPrivateNetworkAddress(address), true, address);
        }
        for (const address of ['8.8.8.8', '172.32.0.1', '2001:4860::8888', '', undefined, 'junk']) {
            assert.equal(isPrivateNetworkAddress(address), false, String(address));
        }
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

describe('Prometheus counter naming', () => {
    it('exposes the vital sample counter with the _total suffix', () => {
        const aggregator = createRumAggregator();

        aggregator.recordVital({ name: 'LCP', value: 1000, rating: 'good', path: '/' });

        const text = toPrometheusText(aggregator.snapshot());

        assert.match(text, /# TYPE webview_lens_vital_samples_total counter/);
        assert.match(
            text,
            /webview_lens_vital_samples_total\{name="LCP",path="\/",env="unknown"\} 1/,
        );
        assert.doesNotMatch(text, /_vital_count/);
    });
});

describe('dev WebSocket bridge subprotocols (Vite HMR)', () => {
    it('forwards the page subprotocol, so servers that require one (vite-hmr) accept the socket', async () => {
        const offered: string[] = [];
        const upgraded = new Set<import('node:stream').Duplex>();
        const server = http.createServer();

        server.on('upgrade', (req, socket) => {
            upgraded.add(socket);
            const protocol = String(req.headers['sec-websocket-protocol'] ?? '');

            offered.push(protocol);
            // Like Vite: only 'vite-hmr' is upgraded, anything else is dropped.
            if (protocol !== 'vite-hmr') {
                socket.destroy();

                return;
            }
            socket.write(
                buildWebSocketAcceptResponse(String(req.headers['sec-websocket-key'])).replace(
                    '\r\n\r\n',
                    '\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n',
                ),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

        const port = (server.address() as AddressInfo).port;
        const fake = createFakeCdp();

        try {
            await startOverride({
                page: PAGE,
                remote: 'https://stand.example.test',
                local: `http://127.0.0.1:${port}`,
                connect: async () => fake.cdp,
                fetchImpl: async () => new Response(''),
                logger: { request: () => undefined, error: () => undefined },
            });

            assert.match(
                bridgeShim('https://stand.example.test', ['/']),
                /new Bridged\(args\[0\], args\[1\]\)/,
            );

            fake.emit('Runtime.bindingCalled', {
                name: '__webviewLensWsSend',
                payload: JSON.stringify({
                    sid: 3,
                    type: 'open',
                    url: 'https://stand.example.test/?token=abc',
                    protocols: ['vite-hmr'],
                }),
            });

            const deadline = Date.now() + 3000;
            let opened = false;

            while (!opened && Date.now() < deadline) {
                opened = fake.calls.some((c) =>
                    String((c.params as { expression?: string }).expression).includes(
                        '(3, "open", "vite-hmr"',
                    ),
                );
                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            assert.deepEqual(offered, ['vite-hmr']);
            assert.ok(opened, 'the page is told the socket opened with the negotiated subprotocol');
        } finally {
            fake.cdp.close();
            // Upgraded sockets leave the server's bookkeeping: close them explicitly.
            for (const socket of upgraded) socket.destroy();
            server.close();
        }
    });
});

describe('iOS fixes found on a real iPhone (iOS 26.6)', () => {
    it('translates Page.navigate, which WebKit lacks, into an in-page navigation', () => {
        assert.deepEqual(translateCdpToWip('Page.navigate', { url: 'https://stand.test/orders' }), {
            method: 'Runtime.evaluate',
            params: {
                expression: 'location.assign("https://stand.test/orders")',
                returnByValue: true,
            },
        });
    });

    it('keeps CLS n/a (null) where layout-shift entries do not exist', () => {
        assert.match(COLLECTOR, /cls: clsSupported \? 0 : null/);
    });

    it('counts an iPhone seen over USB and Wi-Fi once', () => {
        const udid = '00008150-00086C513621401C';

        assert.equal(
            describeIosDevices(
                {
                    available: true,
                    devices: [
                        { deviceId: 1, udid, connectionType: 'USB' },
                        { deviceId: 2, udid, connectionType: 'USB' },
                        { deviceId: 3, udid, connectionType: 'Network' },
                    ],
                },
                undefined,
                'darwin',
            ),
            null,
        );
    });

    it('does not hand the Android forward port to the iOS driver', async () => {
        let seenPort: unknown = 'not called';
        const target = {
            id: 'p1',
            platform: 'ios' as const,
            type: 'page',
            url: 'https://stand.test/',
            title: '',
            debuggerUrl: 'ws://x',
        };
        const driver = {
            platform: 'ios' as const,
            listDevices: () => [],
            isAvailable: () => true,
            diagnose: async () => '',
            doctor: async () => ({ platform: 'ios' as const, checks: [], targets: [] }),
            listTargets: async () => [target],
            getDeviceDescription: async () => 'iPhone',
            waitForTarget: async (_predicate: unknown, options: { port?: unknown } = {}) => {
                seenPort = options.port;

                return target;
            },
            connectInspector: async () => {
                let resolveClosed!: () => void;

                return {
                    platform: 'ios' as const,
                    capabilities: { lcp: true, cls: false, inp: false, cdpFetchOverride: false },
                    evaluate: async <T>() =>
                        JSON.stringify({ lcp: 80, fcp: 30, cls: null, inp: null, ttfb: 20 }) as T,
                    addInitScript: async () => undefined,
                    navigate: async () => undefined,
                    reload: async () => undefined,
                    setCacheDisabled: async () => undefined,
                    close: () => resolveClosed(),
                    closed: new Promise<void>((resolve) => {
                        resolveClosed = resolve;
                    }),
                };
            },
        };

        await measureVitals({ driver, paths: ['/'], runs: 1, settleMs: 0, log: () => undefined });
        assert.equal(seenPort, undefined);
    });
});

describe('iOS proxy self-checks', () => {
    it('answers http://webview-lens.check/ itself, so the iPhone can see that it uses the proxy', async () => {
        const proxy = await startIosMitmProxy({
            remote: 'https://stand.example.test',
            local: 'http://127.0.0.1:1',
            port: 0,
            host: '127.0.0.1',
            ca: generateRootCa(),
            logger: { request: () => undefined, error: () => undefined },
        });

        try {
            const body = await new Promise<string>((resolve, reject) => {
                http.get(
                    { host: '127.0.0.1', port: proxy.port, path: 'http://webview-lens.check/' },
                    (res) => {
                        let text = '';

                        res.setEncoding('utf8');
                        res.on('data', (chunk: string) => (text += chunk));
                        res.on('end', () => resolve(text));
                    },
                ).on('error', reject);
            });

            assert.match(body, /Proxy: OK/);
            assert.match(body, /https:\/\/stand\.example\.test\/__webview-lens\/ok/);
        } finally {
            await proxy.close();
        }
    });

    it('explains certificate failures of bypassed requests', () => {
        const error = new TypeError('fetch failed', {
            cause: Object.assign(new Error('unable to verify'), {
                code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            }),
        });

        assert.match(
            describeFetchError(error),
            /UNABLE_TO_VERIFY_LEAF_SIGNATURE.*NODE_EXTRA_CA_CERTS/,
        );
        assert.equal(
            describeFetchError(
                new TypeError('fetch failed', {
                    cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
                }),
            ),
            'fetch failed (ECONNREFUSED)',
        );
    });
});

describe('Android: several WebViews on the same URL', () => {
    it('works with the page on screen, not a WebView left below it', () => {
        const page = (id: string, attached: boolean) => ({
            id,
            type: 'page',
            url: 'https://stand.test/',
            title: '',
            webSocketDebuggerUrl: `ws://x/${id}`,
            description: JSON.stringify({ attached, visible: true }),
        });
        const pages = [page('below-1', false), page('on-screen', true), page('below-2', false)];

        assert.equal(pickPage(pages, (p) => p.type === 'page')?.id, 'on-screen');
        assert.equal(pickPage([page('only', false)], () => true)?.id, 'only');
        assert.equal(
            pickPage(null, () => true),
            undefined,
        );
    });
});

describe('enableIfSupported (iOS domains)', () => {
    it('ignores a method this WebKit lacks but surfaces any other failure', async () => {
        const cdpThat = (message: string) =>
            ({
                send: async () => {
                    throw new Error(message);
                },
            }) as unknown as Parameters<typeof enableIfSupported>[0];

        await enableIfSupported(cdpThat("'Page.enable' was not found"), 'Page.enable');
        await assert.rejects(
            enableIfSupported(cdpThat('DevTools connection closed'), 'Page.enable'),
            /connection closed/,
        );
    });
});
