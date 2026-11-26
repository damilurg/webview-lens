// Every regular expression in src/, tested as it is written there: the literals are read from the
// source with the TypeScript compiler (not copied here), so a changed regex runs against these cases
// and a new one fails until it has cases. Each has positive, negative and edge cases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { parseListDevicesPlist } from '../src/node/drivers/ios/usbmux.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

/** `match`: whether it matches. `groups`: capture groups of the first match. `count`: matches of a /g regex. */
interface Case {
    input: string;
    match: boolean;
    groups?: readonly (string | undefined)[];
    count?: number;
}

interface Entry {
    /** What the regex is for, in the code that uses it. */
    purpose: string;
    positive: readonly Case[];
    negative: readonly Case[];
    /** Boundaries: empty input, case, Unicode, near misses, what it deliberately accepts. */
    edge: readonly Case[];
}

const yes = (input: string, extra: Omit<Case, 'input' | 'match'> = {}): Case => ({
    input,
    match: true,
    ...extra,
});
const no = (input: string): Case => ({ input, match: false });

// Keys: `<file under src/> <regex literal exactly as in the source>`.
const REGISTRY: Readonly<Record<string, Entry>> = {
    [String.raw`node/adb.ts /\r?\n/`]: {
        purpose: 'splits adb output into lines (LF or CRLF)',
        positive: [yes('a\nb'), yes('a\r\nb')],
        negative: [no('a b'), no('')],
        edge: [no('a\rb'), yes('\n')],
    },
    [String.raw`node/adb.ts /\s+/`]: {
        purpose: 'splits a line of adb output into columns',
        positive: [yes('serial device'), yes('a\t  b')],
        negative: [no('serial'), no('')],
        edge: [yes(' '), yes('a\u00a0b')],
    },
    [String.raw`node/adb.ts /mFocusedApp=ActivityRecord\{[^}]*?\s([\w.]+)\/[^}\s]+/`]: {
        purpose: 'package of the focused app in dumpsys window',
        positive: [
            yes(
                '  mFocusedApp=ActivityRecord{4e1e9bf u0 dev.webviewlens.playground.kotlin/.WebActivity t533}',
                {
                    groups: ['dev.webviewlens.playground.kotlin'],
                },
            ),
            yes(
                'mFocusedApp=ActivityRecord{a u0 com.android.chrome/com.google.android.apps.chrome.Main}',
                {
                    groups: ['com.android.chrome'],
                },
            ),
        ],
        negative: [
            no('mFocusedApp=null'),
            no('mResumedActivity: ActivityRecord{4e1e9bf u0 com.x/.Main t1}'),
        ],
        edge: [
            yes('mFocusedApp=ActivityRecord{x u0 com.a_b.c/.Main}', { groups: ['com.a_b.c'] }),
            no('mFocusedApp=ActivityRecord{}'),
            no('mFocusedApp=ActivityRecord{a u0 /.Act}'),
            no('mFocusedApp=ActivityRecord{a} u0 com.p/.A'),
        ],
    },
    [String.raw`node/adb.ts /mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/[^}\s]+\}/`]: {
        purpose: 'package of the focused window (fallback when mFocusedApp is missing)',
        positive: [
            yes('mCurrentFocus=Window{a1b2 u0 com.miui.home/com.miui.home.launcher.Launcher}', {
                groups: ['com.miui.home'],
            }),
        ],
        negative: [no('mCurrentFocus=Window{a1b2 u0 StatusBar}'), no('mCurrentFocus=null')],
        edge: [
            no('mCurrentFocus=Window{a u0 com.x/.A'),
            no(''),
            no('mCurrentFocus=Window{a u0 /.Act}'),
            no('mCurrentFocus=Window{a} b com.p/.A}'),
        ],
    },
    [String.raw`node/adb.ts /^\d+$/`]: {
        purpose: 'a PID column of ps output',
        positive: [yes('1234'), yes('0')],
        negative: [no('12a'), no(''), no(' 12')],
        edge: [no('١٢'), no('12\n')],
    },
    [String.raw`node/adb.ts /webview_devtools_remote_\d+/g`]: {
        purpose: 'WebView DevTools sockets in /proc/net/unix',
        positive: [
            yes('0000: 00000002 0 10000 0001 01 123 @webview_devtools_remote_9188', { count: 1 }),
            yes('@webview_devtools_remote_1\n@webview_devtools_remote_22', { count: 2 }),
        ],
        negative: [no('@chrome_devtools_remote'), no('@webview_devtools_remote_')],
        edge: [yes('@webview_devtools_remote_12_extra', { count: 1 }), no('')],
    },
    [String.raw`node/adb.ts /isKeyguardShowing=true|mDreamingLockscreen=true/`]: {
        purpose: 'the phone screen is locked',
        positive: [yes('    isKeyguardShowing=true'), yes('mDreamingLockscreen=true')],
        negative: [no('isKeyguardShowing=false'), no('mDreamingLockscreen=false')],
        edge: [no('mShowingLockscreen=true'), no('')],
    },
    [String.raw`node/devtools-frontend.ts /<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi`]:
        {
            purpose: 'CSP meta tags stripped from the served DevTools frontend',
            positive: [
                yes(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`, {
                    count: 1,
                }),
                yes('<META HTTP-EQUIV=content-security-policy CONTENT=x>', { count: 1 }),
            ],
            negative: [
                no('<meta name="viewport" content="width=device-width">'),
                no('<meta charset="utf-8">'),
            ],
            edge: [
                yes(`<meta http-equiv='Content-Security-Policy-Report-Only' content=x>`, {
                    count: 1,
                }),
                no(''),
                no('<metahttp-equiv=Content-Security-Policy>'),
                no('<meta charset=utf-8><p http-equiv=Content-Security-Policy>'),
            ],
        },
    [String.raw`node/devtools-link.ts /serve_rev\/@([0-9a-f]+)\//`]: {
        purpose: 'DevTools revision in the page frontend URL',
        positive: [
            yes(
                'https://chrome-devtools-frontend.appspot.com/serve_rev/@0985600c06a6/inspector.html',
                {
                    groups: ['0985600c06a6'],
                },
            ),
        ],
        negative: [
            no('/devtools/inspector.html?ws=localhost:9223/devtools/page/1'),
            no('serve_rev/0985600c/'),
        ],
        edge: [no('serve_rev/@ABCDEF/'), no('serve_rev/@abc'), no('serve_rev/@/')],
    },
    [String.raw`node/devtools-link.ts /@([0-9a-f]+)/`]: {
        purpose: 'DevTools revision in WebKit-Version',
        positive: [
            yes('537.36 (@0985600c06a688b9c669e74afde7dacd5aaed047)', {
                groups: ['0985600c06a688b9c669e74afde7dacd5aaed047'],
            }),
        ],
        negative: [no('537.36'), no('')],
        edge: [yes('@a', { groups: ['a'] }), no('@G12')],
    },
    [String.raw`node/drivers/ios/certs.ts /.{1,64}/g`]: {
        purpose: 'wraps base64 into 64-character PEM lines',
        positive: [yes('a'.repeat(64), { count: 1 }), yes('a'.repeat(130), { count: 3 })],
        negative: [no('')],
        edge: [yes('a'.repeat(65), { count: 2 }), yes('a\nb', { count: 2 })],
    },
    [String.raw`node/drivers/ios/certs.ts /-----[^-]+-----|\s+/g`]: {
        // Two armour lines and three newlines; four dashes are not armour, only the spaces go.
        purpose: 'PEM armour and whitespace removed before base64 decoding',
        positive: [
            yes('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', { count: 5 }),
            yes('MII B', { count: 1 }),
        ],
        negative: [no('MIIBCgKCAQEA'), no('')],
        edge: [
            yes('---- BEGIN ----', { count: 2 }),
            yes('-----BEGIN-----', { count: 1 }),
            no('----------'),
            yes('-----A-----X-----B-----', { count: 2 }),
        ],
    },
    [String.raw`node/drivers/ios/certs.ts /CN=([^\n]+)/`]: {
        purpose: 'common name of the CA subject (X509Certificate.subject is one field per line)',
        positive: [
            yes('O=webview-lens\nCN=webview-lens Local CA', { groups: ['webview-lens Local CA'] }),
        ],
        negative: [no('O=webview-lens'), no('')],
        edge: [
            yes('CN=a\nO=b', { groups: ['a'] }),
            no('CN='),
            yes('CN=a\rb', { groups: ['a\rb'] }),
        ],
    },
    [String.raw`node/drivers/ios/devtools-bridge.ts /^[0-9a-f]{40}$/`]: {
        purpose: 'a Chromium DevTools frontend revision (40 hex characters)',
        positive: [yes('0985600c06a688b9c669e74afde7dacd5aaed047')],
        negative: [no('0985600c'), no('')],
        edge: [
            no('0985600C06A688B9C669E74AFDE7DACD5AAED047'),
            no('0985600c06a688b9c669e74afde7dacd5aaed0471'),
        ],
    },
    [String.raw`node/drivers/ios/devtools-bridge.ts /^\/devtools\/page\/([^?]+)/`]: {
        purpose: 'page id in a DevTools WebSocket upgrade URL',
        positive: [
            yes('/devtools/page/ios-2', { groups: ['ios-2'] }),
            yes('/devtools/page/abc?x=1', { groups: ['abc'] }),
        ],
        negative: [no('/devtools/browser/abc'), no('/json/list')],
        edge: [no('/devtools/page/'), no('x/devtools/page/abc')],
    },
    [String.raw`node/drivers/ios/index.ts /was not found|not supported/i`]: {
        purpose: 'a WebKit domain that this iOS version lacks (ignored, not an error)',
        positive: [yes("'Network' domain was not found"), yes('Method Not Supported')],
        negative: [no('Connection closed'), no('')],
        edge: [no('was found'), yes('NOT SUPPORTED')],
    },
    [String.raw`node/drivers/ios/index.ts /:(\d+)$/`]: {
        purpose: 'port at the end of an ios_webkit_debug_proxy device URL',
        positive: [
            yes('localhost:9222', { groups: ['9222'] }),
            yes('[::1]:9223', { groups: ['9223'] }),
        ],
        negative: [no('localhost'), no('localhost:9222/')],
        edge: [no(':'), no('localhost:92a2')],
    },
    [String.raw`node/drivers/ios/mitm-proxy.ts /^\[([^\]]+)\](?::(\d+))?$/`]: {
        purpose: 'IPv6 CONNECT authority, with an optional port',
        positive: [
            yes('[::1]:443', { groups: ['::1', '443'] }),
            yes('[fe80::1]', { groups: ['fe80::1', undefined] }),
        ],
        negative: [no('::1:443'), no('[::1]:')],
        edge: [no('[]:443'), no('[::1]:443x'), no('[a]b]:1'), no('x[::1]:443')],
    },
    [String.raw`node/drivers/ios/mitm-proxy.ts /unknown[_\s]ca|certificate[_\s]unknown|bad[_\s]certificate|alert.*certificate/i`]:
        {
            purpose: 'TLS errors that mean iOS does not trust the proxy CA',
            positive: [
                yes('SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca'),
                yes('ssl/tls alert certificate unknown:SSL alert number 46'),
                yes('alert bad certificate'),
            ],
            negative: [no('read ECONNRESET'), no('wrong version number')],
            edge: [yes('UNKNOWN_CA'), no('unknowncertificate'), no('unknown-ca')],
        },
    [String.raw`node/drivers/ios/mitm-proxy.ts /alert ([a-z ]+?)(?::|$)/i`]: {
        purpose: 'name of the TLS alert, for the message',
        positive: [
            yes('ssl/tls alert certificate unknown:SSL alert number 46', {
                groups: ['certificate unknown'],
            }),
            yes('tlsv1 alert unknown ca', { groups: ['unknown ca'] }),
        ],
        negative: [no('handshake failure'), no('')],
        edge: [
            yes('ALERT Bad Certificate', { groups: ['Bad Certificate'] }),
            no('alert 46'),
            no('alert :x'),
        ],
    },
    [String.raw`node/drivers/ios/mitm-proxy.ts /ECONNRESET|socket hang up/i`]: {
        purpose: 'iOS dropped the handshake without an alert',
        positive: [yes('read ECONNRESET'), yes('socket hang up')],
        negative: [no('ETIMEDOUT'), no('')],
        edge: [yes('econnreset'), no('socket hung up')],
    },
    [String.raw`node/drivers/ios/mitm-proxy.ts /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i`]: {
        purpose: 'fetch to the stand failed on its certificate (hint: NODE_EXTRA_CA_CERTS)',
        positive: [
            yes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
            yes('SELF_SIGNED_CERT_IN_CHAIN'),
            yes('ERR_TLS_CERT_ALTNAME_INVALID'),
        ],
        negative: [no('ECONNREFUSED'), no('fetch failed')],
        edge: [yes('self_signed'), no('')],
    },
    [String.raw`node/drivers/ios/mitm-proxy.ts /^http:\/\//i`]: {
        purpose: 'absolute-form plain HTTP request through the proxy',
        positive: [yes('http://webview-lens.check/'), yes('HTTP://stand.test/path')],
        negative: [no('/'), no('https://stand.test/')],
        edge: [no(''), no(' http://x/')],
    },
    [String.raw`node/drivers/ios/usbmux.ts /<key>DeviceList<\/key>\s*<array>([\s\S]*?)<\/array>/`]:
        {
            purpose: 'the device list in a usbmuxd ListDevices plist',
            positive: [
                yes('<dict><key>DeviceList</key>\n\t<array><dict>x</dict></array></dict>', {
                    groups: ['<dict>x</dict>'],
                }),
                yes('<key>DeviceList</key><array></array>', { groups: [''] }),
            ],
            negative: [no('<key>MessageType</key><string>Result</string>'), no('')],
            edge: [
                yes('<key>DeviceList</key><array>a</array><array>b</array>', { groups: ['a'] }),
                no('<key>DeviceList</key><dict></dict>'),
                yes('<key>DeviceList</key><array>a\nb</array>', { groups: ['a\nb'] }),
            ],
        },
    [String.raw`node/drivers/ios/usbmux.ts /<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g`]: {
        purpose: 'each device entry in a ListDevices plist',
        positive: [
            yes('<key>Properties</key><dict>a</dict>', { count: 1 }),
            yes('<key>Properties</key><dict>a</dict><key>Properties</key>\n<dict>b</dict>', {
                count: 2,
            }),
        ],
        negative: [no('<key>DeviceID</key><integer>1</integer>'), no('')],
        edge: [
            yes('<key>Properties</key><dict></dict>', { count: 1 }),
            no('<key>Properties</key><array></array>'),
            yes('<key>Properties</key><dict>a\nb</dict>', { count: 1 }),
        ],
    },
    [String.raw`node/override.ts /^text\/event-stream\b/i`]: {
        purpose: 'a Server-Sent Events response (CDP Fetch cannot stream it)',
        positive: [yes('text/event-stream'), yes('text/event-stream; charset=utf-8')],
        negative: [no('text/html'), no('application/json')],
        edge: [yes('Text/Event-Stream'), no('text/event-streamer'), no('foo text/event-stream')],
    },
    [String.raw`node/override.ts /:$/`]: {
        purpose: 'drops the colon of URL.protocol for X-Forwarded-Proto',
        positive: [yes('https:'), yes('http:')],
        negative: [no('https'), no('')],
        edge: [no('a:b'), yes(':')],
    },
    [String.raw`node/paths.ts /^[A-Za-z]:\/(?:[^?]*?\/)?Git(\/.*)$/`]: {
        purpose: 'Git Bash rewrote an argument like /faq into C:/Program Files/Git/faq',
        positive: [
            yes('C:/Program Files/Git/faq', { groups: ['/faq'] }),
            yes('D:/Git/catalog/item', { groups: ['/catalog/item'] }),
        ],
        negative: [no('/faq'), no('C:/Users/me/project/faq')],
        edge: [
            no('C:/Program Files/Git'),
            yes('c:/tools/Git/', { groups: ['/'] }),
            no('1:/Git/faq'),
            no('C:/Git/faq\nx'),
            no('xC:/Git/faq'),
        ],
    },
    [String.raw`rum/aggregator.ts /\\/g`]: {
        purpose: 'backslashes escaped in Prometheus label values',
        positive: [yes('a\\b', { count: 1 }), yes('\\\\', { count: 2 })],
        negative: [no('a/b'), no('')],
        edge: [no('\n')],
    },
    [String.raw`rum/aggregator.ts /"/g`]: {
        purpose: 'double quotes escaped in Prometheus label values',
        positive: [yes('say "hi"', { count: 2 })],
        negative: [no("it's"), no('')],
        edge: [no('\u201chi\u201d')],
    },
    [String.raw`rum/aggregator.ts /\n/g`]: {
        purpose: 'newlines escaped in Prometheus label values',
        positive: [yes('a\nb', { count: 1 }), yes('a\r\nb', { count: 1 })],
        negative: [no('a b'), no('')],
        edge: [no('a\rb'), no('\\n')],
    },
    [String.raw`rum/context.ts /;\s*wv\)|\bVersion\/\d+\.\d+\s+Chrome\//i`]: {
        purpose: 'an Android WebView User-Agent',
        positive: [
            yes(
                'Mozilla/5.0 (Linux; Android 11; Redmi Note 8 Pro Build/RP1A; wv) AppleWebKit/537.36 Chrome/157.0 Mobile',
            ),
            yes(
                'Mozilla/5.0 (Linux; Android 4.4.2) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0 Mobile',
            ),
        ],
        negative: [
            no(
                'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/157.0 Mobile Safari/537.36',
            ),
            no(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
            ),
        ],
        edge: [
            yes('(Linux;wv)'),
            no('(Linux; wvx)'),
            no('Version/.0 Chrome/30'),
            yes('(Linux; WV)'),
        ],
    },
    [String.raw`rum/context.ts /\b(iPhone|iPad|iPod)\b/i`]: {
        purpose: 'an iOS device in the User-Agent',
        positive: [
            yes('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X)', { groups: ['iPhone'] }),
            yes('(iPad; CPU OS 18_0)', { groups: ['iPad'] }),
        ],
        negative: [no('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), no('Android')],
        edge: [yes('IPHONE', { groups: ['IPHONE'] }), no('iPhoneX')],
    },
    [String.raw`rum/context.ts /\b(Safari|CriOS|FxiOS|EdgiOS|OPiOS)\//i`]: {
        purpose: 'an iOS browser rather than an app WKWebView (they add their own token)',
        positive: [
            yes('Version/26.6 Mobile/15E148 Safari/604.1', { groups: ['Safari'] }),
            yes('CriOS/131.0 Mobile/15E148', { groups: ['CriOS'] }),
        ],
        negative: [
            no('Mobile/15E148'),
            no('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 PlaygroundFlutter/1.0'),
        ],
        edge: [no('Safari'), yes('safari/1', { groups: ['safari'] })],
    },
    [String.raw`rum/context.ts /[?#]/`]: {
        purpose: 'cuts query and hash off a reported path (they carry user data)',
        positive: [yes('/search?q=secret'), yes('/page#token')],
        negative: [no('/event/:id'), no('')],
        edge: [yes('?'), no('/a%3Fb')],
    },
    [String.raw`rum/context.ts /[^\w\-./[\]:]/g`]: {
        purpose: 'characters a reported path may not contain (replaced by _)',
        positive: [yes('/a b', { count: 1 }), yes('/ü<x>', { count: 3 })],
        negative: [no('/event/:id/[slug]'), no('/a-b.c_d')],
        edge: [no(''), yes('/a%20b', { count: 1 })],
    },
    [String.raw`shared/thresholds.ts /^\/[\w\-./[\]:]*$/`]: {
        purpose: 'a valid reported path on the server',
        positive: [yes('/'), yes('/event/:id/[slug]')],
        negative: [no('event'), no('/a b'), no('/a?b')],
        edge: [no(''), no('/ü'), no('a/b')],
    },
    [String.raw`shared/thresholds.ts /^[\w.-]{1,40}$/`]: {
        purpose: 'a context tag key (bounded, safe characters)',
        positive: [yes('env'), yes('app.version-2')],
        negative: [no('a b'), no(''), no('key:value')],
        edge: [yes('k'.repeat(40)), no('k'.repeat(41))],
    },
    [String.raw`shared/thresholds.ts /^[\w.-]{1,64}$/`]: {
        purpose: 'a custom timing name',
        positive: [yes('bridge.init'), yes('checkout-step_2')],
        negative: [no('bridge init'), no('')],
        edge: [yes('t'.repeat(64)), no('t'.repeat(65))],
    },
    [String.raw`shared/utils.ts /\/+$/`]: {
        purpose: 'trailing slashes of an origin or base path',
        positive: [yes('https://stand.test/'), yes('/shop///')],
        negative: [no('https://stand.test'), no('')],
        edge: [yes('/'), no('/shop/ ')],
    },
    [String.raw`shared/utils.ts /^https?:/i`]: {
        purpose: 'a web page (not about:, file:, chrome-extension:)',
        positive: [yes('https://stand.test/'), yes('http://localhost:5173')],
        negative: [
            no('about:blank'),
            no('file:///var/app/index.html'),
            no('chrome-extension://abc/'),
        ],
        edge: [yes('HTTPS://stand.test'), no('httpx://a'), no(''), no('see https://stand.test')],
    },
    [String.raw`shared/utils.ts /^http/i`]: {
        purpose: 'the scheme turned into ws / wss',
        positive: [yes('http://localhost:5173/'), yes('https://stand.test/')],
        negative: [no('ws://already'), no('')],
        edge: [yes('HTTPS://stand.test'), no(' http://x')],
    },
    [String.raw`shared/utils.ts /^\[|\]$/g`]: {
        purpose: 'IPv6 brackets of a URL hostname',
        positive: [yes('[::1]', { count: 2 }), yes('[fe80::1]', { count: 2 })],
        negative: [no('localhost'), no('127.0.0.1')],
        edge: [yes('[::1', { count: 1 }), no(''), no('a]b'), no('a[b')],
    },
};

const collectFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) return collectFiles(full);

        return entry.name.endsWith('.ts') ? [full] : [];
    });

/** Regex literals in src/ as `<file> <literal>` → RegExp built from that literal. */
const collectRegexes = (): Map<string, RegExp> => {
    const found = new Map<string, RegExp>();
    const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) return walk(full);

            return entry.name.endsWith('.ts') ? [full] : [];
        });

    for (const file of walk(SRC)) {
        const source = ts.createSourceFile(
            file,
            fs.readFileSync(file, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
        );
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const visit = (node: ts.Node): void => {
            if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
                const literal = node.getText(source);
                const end = literal.lastIndexOf('/');

                found.set(
                    `${rel} ${literal}`,
                    new RegExp(literal.slice(1, end), literal.slice(end + 1)),
                );
            }
            ts.forEachChild(node, visit);
        };

        visit(source);
    }

    return found;
};

/**
 * Small changes that alter what a regex means: anchors removed, a flag dropped, a quantifier or a
 * character class loosened. A case set that cannot tell the mutant from the original is too weak.
 */
const mutants = (regex: RegExp): { name: string; mutant: RegExp }[] => {
    const { source, flags } = regex;
    const candidates: { name: string; source: string; flags: string }[] = [
        { name: 'no ^', source: source.replace(/^\^/, ''), flags },
        { name: 'no $', source: source.replace(/\$$/, ''), flags },
        { name: 'no i flag', source, flags: flags.replace('i', '') },
        { name: '+ → *', source: source.replace(/(?<!\\)\+/, '*'), flags },
        {
            name: 'first class → .',
            source: source.replace(/(?<!\\)\[(?:\\.|[^\]])+\]/, '.'),
            flags,
        },
    ];

    return candidates
        .filter((candidate) => candidate.source !== source || candidate.flags !== flags)
        .flatMap(({ name, source: mutated, flags: mutatedFlags }) => {
            // A mutation that breaks the syntax is not a different meaning, just no regex.
            try {
                return [{ name, mutant: new RegExp(mutated, mutatedFlags) }];
            } catch {
                return [];
            }
        });
};

/** Runs one case against a fresh copy of the regex (a /g regex keeps state in lastIndex). */
const check = (regex: RegExp, testCase: Case): string | undefined => {
    const fresh = new RegExp(regex.source, regex.flags);

    if (regex.flags.includes('g')) {
        const count = testCase.input.match(fresh)?.length ?? 0;

        if (count > 0 !== testCase.match)
            return `expected ${testCase.match ? 'a match' : 'no match'}, got ${count}`;
        if (testCase.count !== undefined && count !== testCase.count)
            return `expected ${testCase.count} matches, got ${count}`;

        return undefined;
    }

    const result = fresh.exec(testCase.input);

    if (Boolean(result) !== testCase.match)
        return `expected ${testCase.match ? 'a match' : 'no match'}`;
    if (testCase.groups && result) {
        const groups = result.slice(1);

        if (JSON.stringify(groups) !== JSON.stringify(testCase.groups)) {
            return `expected groups ${JSON.stringify(testCase.groups)}, got ${JSON.stringify(groups)}`;
        }
    }

    return undefined;
};

describe('regular expressions in src/', () => {
    const regexes = collectRegexes();

    it('every regex in the code has cases, and no case set is left for a regex that is gone', () => {
        const missing = [...regexes.keys()].filter((key) => !(key in REGISTRY));
        const stale = Object.keys(REGISTRY).filter((key) => !regexes.has(key));

        assert.deepEqual({ missing, stale }, { missing: [], stale: [] });
    });

    it('every regex has positive, negative and edge cases, and the kinds mean what they say', () => {
        for (const [key, entry] of Object.entries(REGISTRY)) {
            assert.ok(
                entry.positive.length > 0 && entry.positive.every((c) => c.match),
                `${key}: positive cases must match`,
            );
            assert.ok(
                entry.negative.length > 0 && entry.negative.every((c) => !c.match),
                `${key}: negative cases must not match`,
            );
            assert.ok(entry.edge.length > 0, `${key}: needs edge cases`);
        }
    });

    for (const [key, entry] of Object.entries(REGISTRY)) {
        it(`${key}: ${entry.purpose}`, () => {
            const regex = regexes.get(key);

            assert.ok(regex, `${key} is not in src/ any more`);

            const failures = [...entry.positive, ...entry.negative, ...entry.edge].flatMap(
                (testCase) => {
                    const problem = check(regex, testCase);

                    return problem ? [`${JSON.stringify(testCase.input)}: ${problem}`] : [];
                },
            );

            assert.deepEqual(failures, []);
        });
    }

    it('every mutant of every regex is caught by its cases (the cases discriminate, not decorate)', () => {
        const survivors = Object.entries(REGISTRY).flatMap(([key, entry]) => {
            const regex = regexes.get(key);

            if (!regex) return [];

            const cases = [...entry.positive, ...entry.negative, ...entry.edge];

            return mutants(regex).flatMap(({ name, mutant }) =>
                cases.some((testCase) => check(mutant, testCase) !== undefined)
                    ? []
                    : [`${key}  [${name}] ${mutant}`],
            );
        });

        assert.deepEqual(survivors, []);
    });

    it('regexes built at runtime (new RegExp) are only the known ones', () => {
        const dynamic: string[] = [];

        for (const file of [...collectFiles(SRC)]) {
            const source = ts.createSourceFile(
                file,
                fs.readFileSync(file, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );
            const visit = (node: ts.Node): void => {
                if (ts.isNewExpression(node) && node.expression.getText(source) === 'RegExp') {
                    dynamic.push(
                        `${path.relative(SRC, file).split(path.sep).join('/')} ${node.arguments?.[0]?.getText(source) ?? ''}`,
                    );
                }
                ts.forEachChild(node, visit);
            };

            visit(source);
        }

        // Each is tested through the function that builds it, below.
        assert.deepEqual(dynamic, [
            'node/drivers/ios/usbmux.ts `<key>${key}</key>\\\\s*<string>([^<]*)</string>`',
            'node/drivers/ios/usbmux.ts `<key>${key}</key>\\\\s*<integer>(-?\\\\d+)</integer>`',
        ]);
    });

    it('usbmux plist string / integer by key (the runtime regexes): positive, negative, edge', () => {
        const device = (props: string) =>
            `<plist><dict><key>DeviceList</key><array><dict><key>Properties</key><dict>${props}</dict></dict></array></dict></plist>`;
        const parse = (props: string) => parseListDevicesPlist(device(props));

        // Positive: both read, whitespace between key and value allowed.
        assert.deepEqual(
            parse(
                '<key>DeviceID</key>\n\t<integer>7</integer><key>SerialNumber</key> <string>00008150-0008</string>',
            ),
            [{ deviceId: 7, udid: '00008150-0008', connectionType: 'USB' }],
        );
        // Negative: the value under another key, or of another type, is not taken.
        assert.deepEqual(
            parse('<key>DeviceID</key><string>7</string><key>SerialNumber</key><string>x</string>'),
            [],
        );
        assert.deepEqual(
            parse(
                '<key>OtherID</key><integer>7</integer><key>SerialNumber</key><string>x</string>',
            ),
            [],
        );
        // Edge: a negative integer, an empty string (no UDID: skipped), a key that only ends the same.
        assert.deepEqual(
            parse(
                '<key>DeviceID</key><integer>-1</integer><key>SerialNumber</key><string>u</string>',
            ),
            [{ deviceId: -1, udid: 'u', connectionType: 'USB' }],
        );
        assert.deepEqual(
            parse(
                '<key>DeviceID</key><integer>1</integer><key>SerialNumber</key><string></string>',
            ),
            [],
        );
        assert.deepEqual(
            parse(
                '<key>XDeviceID</key><integer>1</integer><key>SerialNumber</key><string>u</string>',
            ),
            [],
        );
    });

    it('the check itself fails on a wrong expectation (so a passing test means something)', () => {
        const regex = /^a(b)?$/;

        assert.equal(check(regex, yes('a')), undefined);
        assert.match(check(regex, no('a')) ?? '', /expected no match/);
        assert.match(check(regex, yes('ab', { groups: ['x'] })) ?? '', /expected groups/);
        assert.match(check(/a/g, yes('aa', { count: 1 })) ?? '', /expected 1 matches, got 2/);
    });
});
