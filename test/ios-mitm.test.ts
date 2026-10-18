import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    classifyTlsError,
    parseConnectTarget,
    shouldInterceptHost,
} from '../src/node/drivers/ios/mitm-proxy.ts';

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
