import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { generateRootCa } from '../src/node/drivers/ios/certs.ts';
import { createIosDevtoolsTranslator } from '../src/node/drivers/ios/devtools-bridge.ts';
import { isPrivateNetworkAddress, startIosMitmProxy } from '../src/node/drivers/ios/mitm-proxy.ts';
import { startOverride } from '../src/node/override.ts';
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
