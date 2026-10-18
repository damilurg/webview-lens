import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
    buildIosMobileConfig,
    generateLeafCert,
    generateRootCa,
} from '../../src/node/drivers/ios/certs.ts';
import {
    buildWsUpgradeHandshake,
    classifyTlsError,
    handleDecryptedRequest,
    shouldInterceptHost,
} from '../../src/node/drivers/ios/mitm-proxy.ts';
import { createUrlMapper } from '../../src/node/override.ts';

describe('Feature: iOS Selective HTTPS MITM dev override (macOS + Windows)', () => {
    describe('Scenario: Zero-dependency X.509 v3 Root CA and SAN leaf certificate generation', () => {
        it('Given a remote host stand.example.test, When Root CA and leaf cert are generated, Then Node X509Certificate verifies chain, CA flag, SAN host match and iOS mobileconfig XML', () => {
            const ca = generateRootCa('webview-lens Test CA');
            const leaf = generateLeafCert('stand.example.test', ca);

            const caCert = new crypto.X509Certificate(ca.certPem);
            const leafCert = new crypto.X509Certificate(leaf.certPem);

            assert.equal(caCert.ca, true);
            assert.equal(leafCert.ca, false);
            assert.equal(leafCert.verify(caCert.publicKey), true);
            assert.equal(leafCert.checkHost('stand.example.test'), 'stand.example.test');
            assert.equal(leafCert.checkHost('other.example.test'), undefined);

            const profile = buildIosMobileConfig(ca.certPem, 'webview-lens Test CA');

            assert.match(
                profile,
                /<key>PayloadType<\/key><string>com\.apple\.security\.root<\/string>/,
            );
            assert.match(profile, /<key>PayloadContent<\/key><data>[A-Za-z0-9+/=\s]+<\/data>/);
        });
    });

    describe('Scenario: Selective MITM only intercepts the configured remote host', () => {
        it('Given target stand.example.test, When CONNECT requests arrive, Then stand.example.test is intercepted while other domains pass through untouched', () => {
            assert.equal(shouldInterceptHost('stand.example.test', 'stand.example.test'), true);
            assert.equal(shouldInterceptHost('STAND.EXAMPLE.TEST', 'stand.example.test'), true);
            assert.equal(shouldInterceptHost('api.apple.com', 'stand.example.test'), false);
            assert.equal(
                shouldInterceptHost('sub.stand.example.test', 'stand.example.test'),
                false,
            );
        });
    });

    describe('Scenario: Decrypted HTTPS requests proxy to local dev server with subpath, cookies, redirects and bypass support', () => {
        it('Given --remote-base /shop and --bypass /api/live, When requests arrive, Then /shop/* serves from localhost with rewritten Location and /api/live proxies to remote', async () => {
            const mapper = createUrlMapper({
                remote: 'https://stand.example.test',
                remoteBase: '/shop',
                local: 'http://127.0.0.1:5173',
                localBase: '/',
            });

            const seen: { url: string; cookie: string | null; referer: string | null }[] = [];
            const fetchImpl: typeof fetch = async (input, init) => {
                const url = String(input);
                const headers = new Headers(init?.headers);

                seen.push({
                    url,
                    cookie: headers.get('cookie'),
                    referer: headers.get('referer'),
                });

                if (url === 'http://127.0.0.1:5173/checkout') {
                    return new Response(null, {
                        status: 302,
                        headers: {
                            location: '/login',
                            'set-cookie': 'session=new; Path=/; HttpOnly',
                        },
                    });
                }

                return new Response('remote-live-data', {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                });
            };

            const checkoutRes = await handleDecryptedRequest({
                method: 'GET',
                url: '/shop/checkout',
                headers: {
                    host: 'stand.example.test',
                    cookie: 'sid=abc',
                    referer: 'https://stand.example.test/shop/cart',
                },
                mapper,
                bypassPrefixes: ['/shop/api/live'],
                fetchImpl,
            });

            assert.equal(checkoutRes.status, 302);
            assert.equal(checkoutRes.headers.location, '/shop/login');
            assert.deepEqual(checkoutRes.setCookies, ['session=new; Path=/; HttpOnly']);
            assert.deepEqual(seen[0], {
                url: 'http://127.0.0.1:5173/checkout',
                cookie: 'sid=abc',
                referer: 'http://127.0.0.1:5173/cart',
            });

            const bypassedRes = await handleDecryptedRequest({
                method: 'GET',
                url: '/shop/api/live',
                headers: { host: 'stand.example.test' },
                mapper,
                bypassPrefixes: ['/shop/api/live'],
                fetchImpl,
            });

            assert.equal(bypassedRes.status, 200);
            assert.equal(bypassedRes.body.toString('utf8'), 'remote-live-data');
            assert.equal(seen[1]?.url, 'https://stand.example.test/shop/api/live');
        });
    });

    describe('Scenario: WebSocket upgrade for HMR and TLS pinning diagnostics', () => {
        it('Given a decrypted WS upgrade and a TLS unknown CA error, Then WS handshake targets local server and TLS failure prints Trust/Pinning guidance', () => {
            const mapper = createUrlMapper({
                remote: 'https://stand.example.test',
                local: 'http://localhost:5173',
            });

            const handshake = buildWsUpgradeHandshake(
                {
                    method: 'GET',
                    url: '/_next/webpack-hmr',
                    headers: {
                        host: 'stand.example.test',
                        origin: 'https://stand.example.test',
                        upgrade: 'websocket',
                        connection: 'Upgrade',
                        'sec-websocket-key': 'abc',
                        'sec-websocket-version': '13',
                    },
                },
                mapper,
            );

            assert.match(handshake, /^GET \/_next\/webpack-hmr HTTP\/1\.1\r\n/);
            assert.match(handshake, /\r\nhost: localhost:5173\r\n/i);
            assert.match(handshake, /\r\norigin: http:\/\/localhost:5173\r\n/i);

            const hint = classifyTlsError(new Error('ssl3_read_bytes:tlsv1 alert unknown ca'));

            assert.match(hint, /Certificate Trust|SSL Pinning/i);
        });
    });
});
