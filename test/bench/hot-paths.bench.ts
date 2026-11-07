// Hot-path performance benchmarks for webview-lens (`npm run bench`).

import { mergeCliConfig, validateProjectConfig } from '../../src/node/config.ts';
import { generateLeafCert, generateRootCa } from '../../src/node/drivers/ios/certs.ts';
import { createIosDevtoolsTranslator } from '../../src/node/drivers/ios/devtools-bridge.ts';
import {
    buildListDevicesPlist,
    decodeUsbmuxPackets,
    encodeUsbmuxPacket,
    parseListDevicesPlist,
} from '../../src/node/drivers/ios/usbmux.ts';
import { bridgeShim, createUrlMapper, toLocalHeaders } from '../../src/node/override.ts';
import { renderQrTerminal } from '../../src/node/qr.ts';
import { formatConsoleEvent, formatExceptionEvent } from '../../src/node/telemetry.ts';
import { decodeWsFrames, encodeWsFrame } from '../../src/node/ws-server.ts';
import { detectWebViewEnv, sanitizeContext, sanitizePath } from '../../src/rum/index.ts';
import { parseTiming, parseVital } from '../../src/rum/server.ts';
import { checkBenchBudgets, formatBenchTable, runBench } from './runner.ts';

const mapper = createUrlMapper({
    remote: 'https://stand.example.test',
    remoteBase: '/shop',
    local: 'http://localhost:5173',
    localBase: '/',
});
const sampleHeaders = {
    Accept: 'text/html',
    Origin: 'https://stand.example.test',
    Referer: 'https://stand.example.test/shop/cart',
    Host: 'stand.example.test',
    'Accept-Encoding': 'br',
};
const sampleCookies = [
    { name: 'sid', value: 'abc123' },
    { name: 'theme', value: 'dark' },
];
const wsPayload = JSON.stringify({
    id: 42,
    method: 'Network.requestWillBeSent',
    params: { requestId: '1000.1', request: { url: 'https://stand.example.test/api/items' } },
});
const usbmuxReplyXml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>DeviceList</key><array><dict><key>DeviceID</key><integer>7</integer><key>Properties</key><dict><key>ConnectionType</key><string>USB</string><key>DeviceID</key><integer>7</integer><key>ProductID</key><integer>4776</integer><key>SerialNumber</key><string>00008110-ABCDEF123456</string></dict></dict></array></dict></plist>`;
const usbmuxFrame = encodeUsbmuxPacket(buildListDevicesPlist(), 1);
const wipConsoleJson = JSON.stringify({
    method: 'Console.messageAdded',
    params: {
        message: {
            level: 'error',
            text: 'bridge failed',
            url: 'https://stand.example.test/src/app.tsx',
            line: 42,
            column: 9,
        },
    },
});
const translator = createIosDevtoolsTranslator();
const vitalInput = {
    name: 'LCP',
    value: 1450.25,
    rating: 'good',
    path: '/event/:id/details',
    navigationType: 'navigate',
    context: { env: 'android-webview', release: '2.4.0' },
};
const timingInput = {
    name: 'bridge.init',
    duration: 42.5,
    path: '/event/:id',
    context: { env: 'ios-wkwebview' },
};
const rootCa = generateRootCa('bench CA');

const results = [
    runBench('ws-server: encode + decode frame', () => {
        const frame = encodeWsFrame(wsPayload);

        decodeWsFrames(frame);
    }),
    runBench('usbmux: encode + decode + parse plist', () => {
        decodeUsbmuxPackets(usbmuxFrame);
        parseListDevicesPlist(usbmuxReplyXml);
    }),
    runBench('ios-bridge: WIP Console → CDP JSON', () => {
        translator.fromUpstream(wipConsoleJson);
    }),
    runBench('override: URL map + toLocalHeaders', () => {
        const localUrl = mapper.toLocal('https://stand.example.test/shop/checkout?step=2');

        mapper.toRemote('/login');
        toLocalHeaders(sampleHeaders, sampleCookies, mapper.localOrigin, mapper.toLocal);
        void localUrl;
    }),
    runBench('override: bridgeShim generation', () => {
        bridgeShim('https://stand.example.test', ['/_next/', '/ws'], [24678]);
    }),
    runBench('rum-client: sanitizePath + context + env', () => {
        sanitizePath('/event/:id/details?secret=1#hash');
        sanitizeContext({ env: detectWebViewEnv('Android; wv) Chrome/126'), release: '2.4.0' });
    }),
    runBench('rum-server: parseVital + parseTiming', () => {
        parseVital(vitalInput);
        parseTiming(timingInput);
    }),
    runBench('telemetry: format console + exception', () => {
        formatConsoleEvent({
            type: 'warning',
            args: [
                { type: 'string', value: 'slow frame' },
                { type: 'number', value: 64 },
            ],
            stackTrace: {
                callFrames: [
                    { url: 'https://stand.example.test/app.js', lineNumber: 12, columnNumber: 4 },
                ],
            },
        });
        formatExceptionEvent({
            exceptionDetails: {
                text: 'Uncaught',
                url: 'https://stand.example.test/app.js',
                lineNumber: 18,
                columnNumber: 2,
                exception: { type: 'object', description: 'ReferenceError: x' },
            },
        });
    }),
    runBench(
        'ios-certs: generateLeafCert (ECDSA P-256)',
        () => {
            generateLeafCert('stand.example.test', rootCa);
        },
        { warmup: 3, iterations: 15, minTimeMs: 50 },
    ),
    runBench('config: validate + mergeCliConfig', () => {
        const parsed = validateProjectConfig({
            platform: 'android',
            preset: 'vite',
            remote: 'https://stand.example.test',
            hmrPorts: [24678],
            logs: true,
        });

        mergeCliConfig(parsed, { platform: 'ios', logs: false });
    }),
    runBench('qr: encode + render UTF-8 terminal QR', () => {
        renderQrTerminal('http://192.168.1.42:8888/webview-lens.mobileconfig');
    }),
];

console.log('\nwebview-lens performance benchmarks\n');
console.log(formatBenchTable(results));
console.log('');

// Generous regression ceilings so CI catches accidental O(n^2) / sync bottlenecks.
const violations = checkBenchBudgets(results, {
    'ws-server: encode + decode frame': 1,
    'usbmux: encode + decode + parse plist': 1,
    'ios-bridge: WIP Console → CDP JSON': 1,
    'override: URL map + toLocalHeaders': 1,
    'rum-client: sanitizePath + context + env': 1,
    'rum-server: parseVital + parseTiming': 1,
    'telemetry: format console + exception': 1,
    'ios-certs: generateLeafCert (ECDSA P-256)': 100,
    'config: validate + mergeCliConfig': 1,
    'qr: encode + render UTF-8 terminal QR': 5,
});

if (violations.length > 0) {
    console.error('Benchmark budget regression detected:');
    for (const v of violations) {
        console.error(`  ✗ ${v.name}: ${v.meanMs.toFixed(3)} ms > ${v.maxMeanMs} ms`);
    }
    process.exitCode = 1;
}
