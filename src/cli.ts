#!/usr/bin/env node
// webview-lens: the web page inside a native app's Android WebView, from your computer.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

import {
    AdbNotFoundError,
    createAdbRunner,
    describeDevices,
    findAdb,
    isKeyguardShowing,
    parseFocusedPackage,
    parseWebViewSockets,
    resolveAdb,
    runAdb,
} from './node/adb.ts';
import { connectCdp, listPages, type PagePredicate } from './node/cdp.ts';
import { waitForPage } from './node/device.ts';
import { startDevtoolsLink } from './node/devtools-link.ts';
import { startOverride, type OverrideSession, type SsePolicy } from './node/override.ts';
import { fromGitBashPath } from './node/paths.ts';
import { isPresetSelection, PRESET_SELECTIONS, resolvePreset } from './node/presets.ts';
import { ensureServer } from './node/server-process.ts';
import { attachTelemetry } from './node/telemetry.ts';
import { formatMetric, measureVitals, toMarkdown } from './node/vitals-lab.ts';
import { METRIC_NAMES } from './shared/thresholds.ts';

const HELP = `webview-lens: inspect, override and measure the page inside an Android app's WebView.

Usage
  webview-lens dev [local-url] [options]   serve the WebView's origin from your local server
  webview-lens devtools [options]          DevTools of the WebView page at a fixed localhost URL
  webview-lens vitals [paths…] [options]   lab Web Vitals from the phone, Markdown report
  webview-lens doctor                      what blocks the connection to the phone

Common options
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
  --link-port <n>         port of the DevTools link (3300, env DEVTOOLS_LINK_PORT)
  Enter reloads the page on the phone, Ctrl+C exits.

vitals
  paths             screens to open (default: /)
  --runs <n>        runs per screen, the median is reported (3)
  --cold            disable the cache (first visit)
  --interact <s>    seconds to tap around after load, for INP (0: not measured)
  --out <file>      Markdown report (webview-vitals.md)

The phone: USB debugging on, the app's WebView debuggable (WebView.setWebContentsDebuggingEnabled).
adb is found in ADB, ANDROID_HOME, ANDROID_SDK_ROOT, the Android SDK, PATH and Downloads.`;

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        help: { type: 'boolean', short: 'h' },
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
        'link-port': { type: 'string', default: process.env.DEVTOOLS_LINK_PORT ?? '3300' },
        runs: { type: 'string', default: '3' },
        cold: { type: 'boolean', default: false },
        interact: { type: 'string', default: '0' },
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

async function dev() {
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
    const hmrPorts = (values['hmr-port'] ?? []).map((p) => {
        const num = Number(p);

        if (!Number.isInteger(num) || num <= 0 || num > 65535) {
            throw new Error(`Invalid --hmr-port "${p}"`);
        }

        return num;
    });
    const local = (args[0] ?? process.env.LOCAL_URL ?? 'http://localhost:3000').replace(/\/$/, '');
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
    const paths = args.length > 0 ? args.map(fromGitBashPath) : ['/'];

    logAdbPath();

    const result = await measureVitals({
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
}

async function doctor() {
    const { adb, checked } = findAdb();
    const report = (ok: boolean, line: string) => console.log(`${ok ? '✓' : '✗'} ${line}`);

    if (!adb) {
        report(false, `adb not found, looked in: ${checked.join('; ')}`);

        return;
    }
    report(true, `adb: ${adb}`);

    try {
        const devicesProblem = describeDevices(runAdb(['devices']), serial);

        report(!devicesProblem, devicesProblem ?? 'phone connected, debugging allowed');
        if (devicesProblem) return;

        const deviceRun = createAdbRunner(serial, runAdb);
        const window = deviceRun(['shell', 'dumpsys', 'window']);

        report(
            !isKeyguardShowing(window),
            isKeyguardShowing(window) ? 'screen locked' : 'screen unlocked',
        );
        report(true, `app on screen: ${parseFocusedPackage(window) ?? 'unknown'}`);

        const sockets = parseWebViewSockets(deviceRun(['shell', 'cat', '/proc/net/unix']));

        report(sockets.length > 0, `debuggable WebViews: ${sockets.join(', ') || 'none'}`);
    } catch (error) {
        report(
            false,
            error instanceof AdbNotFoundError ? 'adb not found' : `adb: ${errorMessage(error)}`,
        );

        return;
    }

    const pages = await listPages(port);

    report(
        Boolean(pages),
        pages
            ? `port ${port}: ${pages.length} page(s)`
            : `port ${port}: no answer (run dev, devtools or vitals to forward it)`,
    );
    for (const page of pages ?? []) console.log(`    ${page.type} ${page.url}`);
}

const commands: Record<string, () => Promise<void>> = { dev, devtools, vitals, doctor };
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
