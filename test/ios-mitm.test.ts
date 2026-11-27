import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    classifyTlsError,
    parseConnectTarget,
    shouldInterceptHost,
    describeFetchError,
    isPrivateNetworkAddress,
    startIosMitmProxy,
} from '../src/node/drivers/ios/mitm-proxy.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateRootCa } from '../src/node/drivers/ios/certs.ts';

describe('parseConnectTarget', () => {
    it('parses host:port, default 443 and IPv6 bracketed authorities', () => {
        assert.deepEqual(parseConnectTarget('stand.example.test:443'), {
            host: 'stand.example.test',
            port: 443,
        });
        assert.deepEqual(parseConnectTarget('stand.example.test:8443'), {
            host: 'stand.example.test',
            port: 8443,
        });
        assert.deepEqual(parseConnectTarget('[::1]:443'), { host: '::1', port: 443 });
        assert.equal(parseConnectTarget(''), null);
    });
});

describe('shouldInterceptHost & classifyTlsError', () => {
    it('matches only exact host case-insensitively', () => {
        assert.equal(shouldInterceptHost('Example.COM', 'example.com'), true);
        assert.equal(shouldInterceptHost('other.com', 'example.com'), false);
    });

    it('gives specific guidance for unknown CA / reset errors vs generic TLS errors', () => {
        assert.match(
            classifyTlsError(new Error('ERR_SSL_TLSV1_ALERT_UNKNOWN_CA')),
            /Certificate Trust/,
        );
        assert.match(classifyTlsError(new Error('read ECONNRESET')), /SSL Pinning|Trust/i);
        assert.match(classifyTlsError(new Error('some other failure')), /some other failure/);
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
