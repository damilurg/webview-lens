#!/usr/bin/env node
// webview-lens: the web page inside a native app's Android WebView, from your computer.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

import { resolveAdb } from './node/adb.ts';
import { connectCdp, type PagePredicate } from './node/cdp.ts';
import { waitForPage } from './node/device.ts';
import { startDevtoolsLink } from './node/devtools-link.ts';
import { defaultCertDir, ensureRootCa } from './node/drivers/ios/certs.ts';
import { startIosDevtoolsLink } from './node/drivers/ios/devtools-bridge.ts';
import { ensureIwdp } from './node/drivers/ios/iwdp.ts';
import { detectLanAddresses, startIosMitmProxy } from './node/drivers/ios/mitm-proxy.ts';
import { resolveDriver } from './node/drivers/registry.ts';
import { isPlatformSelection, PLATFORM_SELECTIONS } from './node/drivers/types.ts';
import { startOverride, type OverrideSession, type SsePolicy } from './node/override.ts';
import { fromGitBashPath } from './node/paths.ts';
import { isPresetSelection, PRESET_SELECTIONS, resolvePreset } from './node/presets.ts';
import { ensureServer } from './node/server-process.ts';
import { attachTelemetry } from './node/telemetry.ts';
import {
    checkBudgets,
    formatMetric,
    measureVitals,
    parseBudgets,
    toMarkdown,
} from './node/vitals-lab.ts';
import { METRIC_NAMES } from './shared/thresholds.ts';

const HELP = `webview-lens: inspect, override and measure the page inside an Android app's WebView.

Usage
  webview-lens dev [local-url] [options]   serve the WebView's origin from your local server
  webview-lens devtools [options]          DevTools of the WebView page at a fixed localhost URL
  webview-lens vitals [paths…] [options]   lab Web Vitals from the phone, Markdown report
  webview-lens cert [options]              serve local Root CA profile (.mobileconfig) for iOS setup
  webview-lens doctor                      what blocks the connection to the phone

Common options
  --platform <p>    device platform: auto, android, ios (auto)
  --port <n>        local port forwarded to the WebView DevTools socket (9223, env DEVTOOLS_PORT)
  --serial <id>     target Android device serial when multiple phones are connected (env ANDROID_SERIAL)
  --app <package>   pin WebView discovery to a specific Android package name
  --match <text>    attach to the page whose URL contains text (default: any https page)
  --logs            stream console logs, uncaught exceptions and 4xx/5xx network errors to terminal

dev
  local-url               local server (http://localhost:3000, env LOCAL_URL)
  --preset <name>         bundler defaults: auto, next, vite, webpack, nuxt, angular, generic (auto)
  --remote <url>          origin to serve (default: the origin the WebView is on)
  --remote-base <path>    stand subpath to override (e.g. /shop)
  --local-base <path>     local server subpath mapped to --remote-base (default: /)
  --cmd <command>         start the local server with this command when it does not answer
  --ws <prefix>           WebSocket path prefix bridged to the local server, repeatable
  --hmr-port <n>          separate local HMR port bridged over CDP, repeatable
  --quiet <prefix>        path prefix hidden from request logs, repeatable
  --bypass <prefix>       path prefix passed straight through to the stand, repeatable
  --sse <fail|continue>   handling of text/event-stream responses (fail)
  --proxy-port <n>        HTTPS MITM proxy port for iOS dev / cert (8888)
  --link-port <n>         port of the DevTools link (3300, env DEVTOOLS_LINK_PORT)
  Enter reloads the page on the phone, Ctrl+C exits.

vitals
  paths             screens to open (default: /)
  --runs <n>        runs per screen, the median is reported (3)
  --cold            disable the cache (first visit)
  --interact <s>    seconds to tap around after load, for INP (0: not measured)
  --budget <spec>   CI thresholds, e.g. lcp=2500,cls=0.1 (exits 1 if exceeded)
  --out <file>      Markdown report (webview-vitals.md)

The phone: USB debugging on, the app's WebView debuggable (WebView.setWebContentsDebuggingEnabled).
adb is found in ADB, ANDROID_HOME, ANDROID_SDK_ROOT, the Android SDK, PATH and Downloads.`;

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        help: { type: 'boolean', short: 'h' },
        platform: { type: 'string', default: 'auto' },
        port: { type: 'string', default: process.env.DEVTOOLS_PORT ?? '9223' },
        serial: { type: 'string' },
        app: { type: 'string' },
        match: { type: 'string' },
        logs: { type: 'boolean', default: false },
        remote: { type: 'string' },
        'remote-base': { type: 'string' },
        'local-base': { type: 'string' },
        preset: { type: 'string', default: 'auto' },
        cmd: { type: 'string' },
        ws: { type: 'string', multiple: true },
        'hmr-port': { type: 'string', multiple: true },
        quiet: { type: 'string', multiple: true },
        bypass: { type: 'string', multiple: true },
        sse: { type: 'string', default: 'fail' },
        'proxy-port': { type: 'string', default: '8888' },
        'link-port': { type: 'string', default: process.env.DEVTOOLS_LINK_PORT ?? '3300' },
        runs: { type: 'string', default: '3' },
        cold: { type: 'boolean', default: false },
        interact: { type: 'string', default: '0' },
        budget: { type: 'string' },
        out: { type: 'string', default: 'webview-vitals.md' },
    },
});

const [command, ...args] = positionals;
const port = values.port;
const serial = values.serial ?? process.env.ANDROID_SERIAL;
const app = values.app;
const targetOptions = {
    ...(serial ? { serial } : {}),
    ...(app ? { app } : {}),
};

if (values.help || !command) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
}

if (typeof WebSocket === 'undefined') {
    console.error('webview-lens needs Node.js 22.4 or newer (global WebSocket)');
    process.exit(1);
}

const remoteOrigin = values.remote ? new URL(values.remote).origin : undefined;

const isTarget: PagePredicate = (page) => {
    if (page.type !== 'page') return false;
    if (values.match) return page.url.includes(values.match);
    if (remoteOrigin) return true;

    return page.url.startsWith('https://');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const logAdbPath = () => {
    try {
        resolveAdb((adbPath) => console.log(`adb: ${adbPath}`));
    } catch {
        // waitForPage prints where it looked.
    }
};

const selectDriver = async () => {
    if (!isPlatformSelection(values.platform)) {
        throw new Error(
            `Unknown --platform "${values.platform}". Expected one of: ${PLATFORM_SELECTIONS.join(', ')}`,
        );
    }

    return resolveDriver(values.platform);
};

async function dev() {
    const driver = await selectDriver();

    if (!isPresetSelection(values.preset)) {
        throw new Error(
            `Unknown --preset "${values.preset}". Expected one of: ${PRESET_SELECTIONS.join(', ')}`,
        );
    }
    if (values.sse !== 'fail' && values.sse !== 'continue') {
        throw new Error(`Unknown --sse "${values.sse}". Expected "fail" or "continue"`);
    }

    const preset = resolvePreset(values.preset);
    const ssePolicy: SsePolicy = values.sse;
    const wsPrefixes = values.ws ?? preset.wsPrefixes;
    const quietPrefixes = values.quiet ?? preset.quietPrefixes;
    const local = (args[0] ?? process.env.LOCAL_URL ?? 'http://localhost:3000').replace(/\/$/, '');

    if (driver.platform === 'ios') {
        if (!remoteOrigin) {
            throw new Error(
                'iOS `dev` override needs --remote <https://stand.example.com> so the selective MITM proxy knows which host to intercept.',
            );
        }

        const server = await ensureServer(local, values.cmd ? { command: values.cmd } : {});
        const proxyPort = Number(values['proxy-port']);
        const proxy = await startIosMitmProxy({
            remote: remoteOrigin,
            local,
            ...(values['remote-base']
                ? { remoteBase: fromGitBashPath(values['remote-base']) }
                : {}),
            ...(values['local-base'] ? { localBase: fromGitBashPath(values['local-base']) } : {}),
            port: proxyPort,
            quietPrefixes,
            ...(values.bypass ? { bypassPrefixes: values.bypass.map(fromGitBashPath) } : {}),
        });

        const cleanup = () => {
            void proxy.close();
            server?.stop();
        };

        process.on('exit', cleanup);
        process.on('SIGINT', () => process.exit(0));
        process.on('SIGTERM', () => process.exit(0));

        const lanIp = detectLanAddresses()[0] ?? 'localhost';

        console.log(`iOS selective MITM proxy listening on ${lanIp}:${proxy.port}`);
        console.log(
            `Intercepting ONLY ${proxy.targetHost} → ${local} (other domains pass through)`,
        );
        console.log(`Install CA on iPhone (once): http://${lanIp}:${proxy.port}/`);
        console.log(
            `Set iPhone Wi-Fi HTTP Proxy → Manual: Server ${lanIp}, Port ${proxy.port}. Ctrl+C exits.`,
        );

        if (values.logs) {
            for (;;) {
                const target = await driver.waitForTarget(
                    (t) =>
                        t.type === 'page' &&
                        (values.match
                            ? t.url.includes(values.match)
                            : t.url.startsWith(remoteOrigin)),
                    targetOptions,
                );

                try {
                    const session = await driver.connectInspector(target);
                    const detach = await session.attachTelemetry?.();

                    console.log(`Live logs attached to ${target.url}`);
                    await session.closed;
                    detach?.();
                } catch (error) {
                    console.error(errorMessage(error));
                    await sleep(2000);
                }
            }
        }

        await new Promise(() => undefined);
    }

    const hmrPorts = (values['hmr-port'] ?? []).map((p) => {
        const num = Number(p);

        if (!Number.isInteger(num) || num <= 0 || num > 65535) {
            throw new Error(`Invalid --hmr-port "${p}"`);
        }

        return num;
    });
    const server = await ensureServer(local, values.cmd ? { command: values.cmd } : {});

    if (server) {
        process.on('exit', server.stop);
        process.on('SIGINT', () => process.exit(0));
        process.on('SIGTERM', () => process.exit(0));
    }

    logAdbPath();
    console.log(`Preset: ${preset.name} (ws: ${wsPrefixes.join(', ')})`);

    const link = startDevtoolsLink({ port: values['link-port'], devtoolsPort: port, isTarget });
    let session: OverrideSession | undefined;

    readline
        .createInterface({ input: process.stdin })
        .on('line', () => void session?.reload().catch(() => undefined));

    for (;;) {
        const page = await waitForPage(port, isTarget, targetOptions);
        const remote = remoteOrigin ?? new URL(page.url).origin;

        console.log(`WebView: ${page.title} (${remote})`);
        console.log(`DevTools of the phone: ${link.url}, open it in Chrome`);
        try {
            session = await startOverride({
                page,
                remote,
                local,
                ...(values['remote-base']
                    ? { remoteBase: fromGitBashPath(values['remote-base']) }
                    : {}),
                ...(values['local-base']
                    ? { localBase: fromGitBashPath(values['local-base']) }
                    : {}),
                wsPrefixes,
                quietPrefixes,
                ...(hmrPorts.length ? { hmrPorts } : {}),
                ...(values.bypass ? { bypassPrefixes: values.bypass.map(fromGitBashPath) } : {}),
                ssePolicy,
                telemetry: values.logs,
            });
            console.log(`Override on: ${remote} → ${local}. Enter reloads the page, Ctrl+C exits.`);
            await session.closed;
            session = undefined;
            console.log('The WebView page closed, waiting for a new one…');
        } catch (error) {
            session = undefined;
            console.error(errorMessage(error));
            await sleep(2000);
        }
    }
}

async function devtools() {
    const driver = await selectDriver();

    if (driver.platform === 'ios') {
        const iwdpProc = await ensureIwdp();

        if (iwdpProc) {
            process.on('exit', iwdpProc.stop);
            process.on('SIGINT', () => process.exit(0));
            process.on('SIGTERM', () => process.exit(0));
        }

        const matchesIosTarget = (t: { type: string; url: string }) =>
            t.type === 'page' &&
            (!values.match
                ? remoteOrigin
                    ? true
                    : t.url.startsWith('https://')
                : t.url.includes(values.match));

        const link = startIosDevtoolsLink({
            port: values['link-port'],
            resolveTarget: async () =>
                (await driver.listTargets(targetOptions))?.find(matchesIosTarget),
        });

        console.log(`iOS DevTools (WIP↔CDP bridge): ${link.url}, open it in Chrome. Ctrl+C exits.`);
        for (;;) {
            const target = await driver.waitForTarget(matchesIosTarget, targetOptions);

            console.log(`iOS WKWebView: ${target.title} (${target.url})`);
            if (values.logs) {
                try {
                    const session = await driver.connectInspector(target);
                    const detach = await session.attachTelemetry?.();

                    console.log(`Live logs attached to ${target.url}`);
                    await session.closed;
                    detach?.();
                } catch (error) {
                    console.error(errorMessage(error));
                    await sleep(2000);
                }
            } else {
                await sleep(5000);
            }
        }
    }

    logAdbPath();

    const link = startDevtoolsLink({ port: values['link-port'], devtoolsPort: port, isTarget });

    console.log(`DevTools of the phone: ${link.url}, open it in Chrome. Ctrl+C exits.`);

    // Keeps the forward fresh across app restarts; the link server reads /json/list on each open.
    for (;;) {
        const page = await waitForPage(port, isTarget, targetOptions);

        if (values.logs) {
            try {
                const cdp = await connectCdp(page.webSocketDebuggerUrl);
                const detach = attachTelemetry(cdp);

                await cdp.send('Runtime.enable');
                await cdp.send('Network.enable');
                console.log(`Live logs attached to ${page.url}`);
                await cdp.closed;
                detach();
            } catch (error) {
                console.error(errorMessage(error));
                await sleep(2000);
            }
        } else {
            await sleep(5000);
        }
    }
}

async function vitals() {
    const budgets = values.budget ? parseBudgets(values.budget) : undefined;
    const driver = await selectDriver();
    const paths = args.length > 0 ? args.map(fromGitBashPath) : ['/'];

    if (driver.platform === 'android') logAdbPath();

    const result = await measureVitals({
        driver,
        devtoolsPort: port,
        paths,
        runs: Number(values.runs),
        cold: values.cold,
        interact: Number(values.interact),
        wait: targetOptions,
        isTarget: (page) =>
            page.type === 'page' &&
            /^https?:/.test(page.url) &&
            (!values.match || page.url.includes(values.match)),
    });

    console.table(
        Object.fromEntries(
            result.rows.map((row) => [
                row.path,
                Object.fromEntries(METRIC_NAMES.map((m) => [m, formatMetric(m, row[m])])),
            ]),
        ),
    );

    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    fs.writeFileSync(values.out, toMarkdown(result));
    console.log(`Report: ${path.resolve(values.out)}`);

    if (budgets) {
        const violations = checkBudgets(result, budgets);

        if (violations.length > 0) {
            console.error('Performance budget exceeded:');
            for (const v of violations) {
                console.error(
                    `  ✗ ${v.path} ${v.metric}: ${formatMetric(v.metric, v.actual)} > ${formatMetric(v.metric, v.limit)}`,
                );
            }
            process.exitCode = 1;
        } else {
            console.log('✓ All performance budgets passed');
        }
    }
}

async function doctor() {
    const driver = await selectDriver();
    const report = await driver.doctor({ port, ...targetOptions });

    for (const check of report.checks) {
        console.log(`${check.ok ? '✓' : '✗'} ${check.message}`);
    }
    for (const target of report.targets) {
        console.log(`    ${target.type} ${target.url}`);
    }
}

async function cert() {
    const certDir = defaultCertDir();
    const ca = ensureRootCa(certDir);
    const proxyPort = Number(values['proxy-port']);
    const proxy = await startIosMitmProxy({
        remote: remoteOrigin ?? 'https://webview-lens.local',
        local: 'http://127.0.0.1:3000',
        port: proxyPort,
        ca,
    });

    process.on('SIGINT', () => {
        void proxy.close().finally(() => process.exit(0));
    });

    const lanIp = detectLanAddresses()[0] ?? 'localhost';

    console.log(`Root CA stored in: ${certDir}`);
    console.log(`Open on your iPhone in Safari: http://${lanIp}:${proxy.port}/`);
    console.log(
        `Direct profile URL:            http://${lanIp}:${proxy.port}/webview-lens.mobileconfig`,
    );
    console.log(
        'After installing, enable trust in: Settings → General → About → Certificate Trust Settings. Ctrl+C exits.',
    );
    await new Promise(() => undefined);
}

const commands: Record<string, () => Promise<void>> = { dev, devtools, vitals, cert, doctor };
const run = commands[command];

if (!run) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
}

try {
    await run();
} catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
}
