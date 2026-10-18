// Zero-dependency X.509 v3 Root CA and SAN leaf certificate generator (ECDSA P-256 + SHA-256)
// for the iOS selective HTTPS MITM proxy, plus Apple .mobileconfig profile builder.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface CertPair {
    certPem: string;
    keyPem: string;
}

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SAN = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const derLen = (length: number): Buffer => {
    if (length < 0x80) return Buffer.from([length]);

    const bytes: number[] = [];
    let n = length;

    while (n > 0) {
        bytes.unshift(n & 0xff);
        n >>= 8;
    }

    return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const derTag = (tag: number, content: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);

const derSequence = (...items: Buffer[]): Buffer => derTag(0x30, Buffer.concat(items));
const derSet = (...items: Buffer[]): Buffer => derTag(0x31, Buffer.concat(items));
const derExplicit = (num: number, inner: Buffer): Buffer => derTag(0xa0 | num, inner);
const derImplicit = (num: number, content: Buffer): Buffer => derTag(0x80 | num, content);
const derOctetString = (content: Buffer): Buffer => derTag(0x04, content);
const derBitString = (content: Buffer, unusedBits = 0): Buffer =>
    derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
const derBoolean = (value: boolean): Buffer => derTag(0x01, Buffer.from([value ? 0xff : 0x00]));
const derUtf8 = (value: string): Buffer => derTag(0x0c, Buffer.from(value, 'utf8'));

const derInteger = (raw: Buffer | number): Buffer => {
    let buf: Buffer;

    if (typeof raw === 'number') {
        if (raw === 0) {
            buf = Buffer.from([0]);
        } else {
            const bytes: number[] = [];
            let n = raw;

            while (n > 0) {
                bytes.unshift(n & 0xff);
                n >>= 8;
            }
            buf = Buffer.from(bytes);
        }
    } else {
        let start = 0;

        while (start < raw.length - 1 && raw[start] === 0) start += 1;
        buf = raw.subarray(start);
    }

    if ((buf[0] ?? 0) & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);

    return derTag(0x02, buf);
};

const derOid = (oid: string): Buffer => {
    const parts = oid.split('.').map(Number);
    const bytes: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];

    for (const part of parts.slice(2)) {
        if (part < 128) {
            bytes.push(part);
            continue;
        }
        const encoded: number[] = [part & 0x7f];
        let n = part >> 7;

        while (n > 0) {
            encoded.unshift((n & 0x7f) | 0x80);
            n >>= 7;
        }
        bytes.push(...encoded);
    }

    return derTag(0x06, Buffer.from(bytes));
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const derTime = (date: Date): Buffer => {
    const year = date.getUTCFullYear();
    const rest = `${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;

    if (year >= 1950 && year <= 2049) {
        return derTag(0x17, Buffer.from(`${pad2(year % 100)}${rest}`, 'ascii'));
    }

    return derTag(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
};

const derName = (commonName: string): Buffer =>
    derSequence(derSet(derSequence(derOid(OID_CN), derUtf8(commonName))));

const derExtension = (oid: string, value: Buffer, critical = false): Buffer =>
    derSequence(derOid(oid), ...(critical ? [derBoolean(true)] : []), derOctetString(value));

const ipv4ToBytes = (ip: string): Buffer => Buffer.from(ip.split('.').map(Number));

const ipv6ToBytes = (ip: string): Buffer => {
    const [head = '', tail = ''] = ip.split('::');
    const left = head ? head.split(':').map((p) => parseInt(p, 16)) : [];
    const right = tail ? tail.split(':').map((p) => parseInt(p, 16)) : [];
    const missing = ip.includes('::') ? 8 - left.length - right.length : 0;
    const words = [...left, ...Array<number>(Math.max(0, missing)).fill(0), ...right];
    const out = Buffer.alloc(16);

    words.slice(0, 8).forEach((word, i) => out.writeUInt16BE(word, i * 2));

    return out;
};

const derToPem = (der: Buffer, label: string): string => {
    const b64 =
        der
            .toString('base64')
            .match(/.{1,64}/g)
            ?.join('\n') ?? '';

    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
};

const pemToDer = (pem: string): Buffer =>
    Buffer.from(pem.replace(/-----[^-]+-----|\s+/g, ''), 'base64');

const randomSerial = (): Buffer => {
    const bytes = crypto.randomBytes(16);

    bytes[0] = (bytes[0]! & 0x7f) | 0x01;

    return bytes;
};

const signCertificate = ({
    subjectCn,
    issuerCn,
    subjectPublicKeyDer,
    issuerPrivateKey,
    daysValid,
    extensions,
}: {
    subjectCn: string;
    issuerCn: string;
    subjectPublicKeyDer: Buffer;
    issuerPrivateKey: crypto.KeyObject;
    daysValid: number;
    extensions: Buffer[];
}): string => {
    const now = Date.now();
    const notBefore = new Date(now - 5 * 60 * 1000);
    const notAfter = new Date(now + daysValid * 24 * 60 * 60 * 1000);
    const algId = derSequence(derOid(OID_ECDSA_SHA256));

    const tbs = derSequence(
        derExplicit(0, derInteger(2)),
        derInteger(randomSerial()),
        algId,
        derName(issuerCn),
        derSequence(derTime(notBefore), derTime(notAfter)),
        derName(subjectCn),
        subjectPublicKeyDer,
        derExplicit(3, derSequence(...extensions)),
    );

    const signature = crypto.sign('sha256', tbs, issuerPrivateKey);
    const certDer = derSequence(tbs, algId, derBitString(signature));

    return derToPem(certDer, 'CERTIFICATE');
};

/** Generates a self-signed X.509 v3 Root CA certificate (ECDSA P-256). */
export const generateRootCa = (commonName = 'webview-lens Local CA'): CertPair => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const certPem = signCertificate({
        subjectCn: commonName,
        issuerCn: commonName,
        subjectPublicKeyDer: spki,
        issuerPrivateKey: privateKey,
        daysValid: 820,
        extensions: [
            derExtension(OID_BASIC_CONSTRAINTS, derSequence(derBoolean(true)), true),
            derExtension(OID_KEY_USAGE, derBitString(Buffer.from([0x06]), 1), true),
        ],
    });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    return { certPem, keyPem };
};

/** Generates a SAN leaf certificate for `host` (DNS or IP) signed by the given Root CA. */
export const generateLeafCert = (host: string, ca: CertPair): CertPair => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const caCert = new crypto.X509Certificate(ca.certPem);
    const issuerCn = caCert.subject.match(/CN=([^\n]+)/)?.[1] ?? 'webview-lens Local CA';
    const caKey = crypto.createPrivateKey(ca.keyPem);

    const sanEntry = net.isIPv4(host)
        ? derImplicit(7, ipv4ToBytes(host))
        : net.isIPv6(host)
          ? derImplicit(7, ipv6ToBytes(host))
          : derImplicit(2, Buffer.from(host, 'ascii'));

    const certPem = signCertificate({
        subjectCn: host,
        issuerCn,
        subjectPublicKeyDer: spki,
        issuerPrivateKey: caKey,
        // Apple requires leaf certificates to have validity <= 398 days.
        daysValid: 365,
        extensions: [
            derExtension(OID_BASIC_CONSTRAINTS, derSequence(), true),
            derExtension(OID_KEY_USAGE, derBitString(Buffer.from([0xa0]), 5), true),
            derExtension(OID_EXT_KEY_USAGE, derSequence(derOid(OID_SERVER_AUTH))),
            derExtension(OID_SAN, derSequence(sanEntry)),
        ],
    });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    return { certPem, keyPem };
};

export const defaultCertDir = (home = os.homedir()): string =>
    path.join(home, '.webview-lens', 'certs');

/** Loads an existing Root CA from `dir`, or generates and persists a new one. */
export const ensureRootCa = (dir = defaultCertDir()): CertPair => {
    const certPath = path.join(dir, 'root-ca.pem');
    const keyPath = path.join(dir, 'root-ca-key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return {
            certPem: fs.readFileSync(certPath, 'utf8'),
            keyPem: fs.readFileSync(keyPath, 'utf8'),
        };
    }

    fs.mkdirSync(dir, { recursive: true });
    const ca = generateRootCa();

    fs.writeFileSync(certPath, ca.certPem, { mode: 0o644 });
    fs.writeFileSync(keyPath, ca.keyPem, { mode: 0o600 });

    return ca;
};

/** Builds an Apple `.mobileconfig` XML profile so iOS Safari can install the Root CA in one tap. */
export const buildIosMobileConfig = (
    caCertPem: string,
    displayName = 'webview-lens Local CA',
): string => {
    const derBase64 = pemToDer(caCertPem).toString('base64');
    const rootUuid = crypto.randomUUID().toUpperCase();
    const certUuid = crypto.randomUUID().toUpperCase();

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>PayloadContent</key>',
        '  <array>',
        '    <dict>',
        '      <key>PayloadCertificateFileName</key><string>webview-lens-ca.cer</string>',
        `      <key>PayloadContent</key><data>${derBase64}</data>`,
        '      <key>PayloadDescription</key><string>Local dev Root CA for webview-lens iOS override</string>',
        `      <key>PayloadDisplayName</key><string>${displayName}</string>`,
        '      <key>PayloadIdentifier</key><string>dev.webview-lens.ca.cert</string>',
        '      <key>PayloadType</key><string>com.apple.security.root</string>',
        `      <key>PayloadUUID</key><string>${certUuid}</string>`,
        '      <key>PayloadVersion</key><integer>1</integer>',
        '    </dict>',
        '  </array>',
        '  <key>PayloadDescription</key><string>Install and trust this profile in Settings → General → About → Certificate Trust Settings to enable webview-lens local dev override on iOS.</string>',
        `  <key>PayloadDisplayName</key><string>${displayName}</string>`,
        '  <key>PayloadIdentifier</key><string>dev.webview-lens.ca.profile</string>',
        '  <key>PayloadOrganization</key><string>webview-lens</string>',
        '  <key>PayloadRemovalDisallowed</key><false/>',
        '  <key>PayloadType</key><string>Configuration</string>',
        `  <key>PayloadUUID</key><string>${rootUuid}</string>`,
        '  <key>PayloadVersion</key><integer>1</integer>',
        '</dict>',
        '</plist>',
    ].join('\n');
};
