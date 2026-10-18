import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    buildIosMobileConfig,
    ensureRootCa,
    generateLeafCert,
    generateRootCa,
} from '../src/node/drivers/ios/certs.ts';

describe('iOS X.509 certificate generator', () => {
    it('creates a valid Root CA and persists/reloads it with ensureRootCa', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-ca-'));
        const first = ensureRootCa(dir);
        const second = ensureRootCa(dir);

        assert.equal(first.certPem, second.certPem);
        assert.equal(first.keyPem, second.keyPem);

        const parsed = new crypto.X509Certificate(first.certPem);

        assert.equal(parsed.ca, true);
        assert.match(parsed.subject, /webview-lens/);
    });

    it('issues valid SAN certificates for both DNS hostnames and IP addresses', () => {
        const ca = generateRootCa();
        const caX509 = new crypto.X509Certificate(ca.certPem);

        const dnsLeaf = new crypto.X509Certificate(generateLeafCert('app.stand.dev', ca).certPem);

        assert.equal(dnsLeaf.verify(caX509.publicKey), true);
        assert.equal(dnsLeaf.checkHost('app.stand.dev'), 'app.stand.dev');

        const ipLeaf = new crypto.X509Certificate(generateLeafCert('192.168.1.50', ca).certPem);

        assert.equal(ipLeaf.verify(caX509.publicKey), true);
        assert.equal(ipLeaf.checkIP('192.168.1.50'), '192.168.1.50');
    });

    it('builds a valid Apple .mobileconfig profile containing base64 DER cert data', () => {
        const ca = generateRootCa();
        const profile = buildIosMobileConfig(ca.certPem);

        assert.ok(profile.includes('<plist version="1.0">'));
        assert.ok(profile.includes('com.apple.security.root'));
        assert.ok(profile.includes('webview-lens'));
    });
});
