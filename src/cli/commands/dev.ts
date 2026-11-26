// `webview-lens dev`: the stand's origin served from your local dev server inside the app.
// Android: CDP Fetch interception of the WebView page. iOS: the selective HTTPS MITM proxy.

import readline from 'node:readline';

import { createAdbRunner, removeReversePort, reversePort } from '../../node/adb.ts';
import { waitForOtherPageOnScreen, waitForPage } from '../../node/device.ts';
import { startDevtoolsLink } from '../../node/devtools-link.ts';
import { startIosMitmProxy } from '../../node/drivers/ios/mitm-proxy.ts';
import {
    detectLanAddresses,
    type NetworkWatchState,
    networkHints,
} from '../../node/drivers/ios/network.ts';
import type { DeviceDriver } from '../../node/drivers/types.ts';
import { type OverrideSession, startOverride } from '../../node/override.ts';
import { resolvePreset } from '../../node/presets.ts';
import { renderQrTerminal } from '../../node/qr.ts';
import { ensureServer } from '../../node/server-process.ts';
import { errorMessage, sleep, stripTrailingSlashes } from '../../shared/utils.ts';
import type { CliContext } from '../context.ts';
import {
    basePathOptions,
    ensureIosProxy,
    forever,
    logAdbPath,
    registerCleanup,
    runTelemetryLoop,
} from '../runtime.ts';
import { pageLog, requestLog, terminal } from '../output.ts';

interface DevSettings {
    local: string;
    wsPrefixes: readonly string[];
    quietPrefixes: readonly string[];
    hmrPorts: readonly number[];
    presetName: string;
}

const devSettings = ({ cfg }: CliContext): DevSettings => {
    const preset = resolvePreset(cfg.preset ?? 'auto');

    return {
        local: stripTrailingSlashes(cfg.local ?? process.env.LOCAL_URL ?? 'http://localhost:3000'),
        wsPrefixes: cfg.ws ?? preset.wsPrefixes,
        quietPrefixes: cfg.quiet ?? preset.quietPrefixes,
        hmrPorts: cfg.hmrPorts ?? [],
        presetName: preset.name,
    };
};

/** The local server is started (when needed) with its output in the terminal. */
const serverOptions = (command: string | undefined) =>
    command ? { command, log: terminal.line } : { log: terminal.line };

/** Says in the terminal when the phone cannot be reaching the proxy (see network.ts). */
const watchNetwork = (announced: string, proxy: { port: number; connections(): number }) => {
    const startedAt = Date.now();
    let state: NetworkWatchState = {
        announced,
        port: proxy.port,
        connections: 0,
        elapsedMs: 0,
        hintedNoClient: false,
    };
    const timer = setInterval(() => {
        const next = networkHints(
            { ...state, connections: proxy.connections(), elapsedMs: Date.now() - startedAt },
            detectLanAddresses(),
        );

        for (const line of next.lines) terminal.error(line);
        state = next.state;
    }, 5000);

    timer.unref();
    registerCleanup(() => clearInterval(timer));
};

const devIos = async (ctx: CliContext, driver: DeviceDriver, settings: DevSettings) => {
    const { cfg, remoteOrigin } = ctx;

    if (!remoteOrigin) {
        throw new Error(
            'iOS `dev` override needs --remote <https://stand.example.com> so the selective MITM proxy knows which host to intercept.',
        );
    }

    const server = await ensureServer(settings.local, serverOptions(cfg.cmd));
    const proxy = await startIosMitmProxy({
        remote: remoteOrigin,
        local: settings.local,
        ...basePathOptions(cfg),
        port: ctx.proxyPort,
        quietPrefixes: settings.quietPrefixes,
        forwardedHeaders: Boolean(cfg.forwarded),
        logger: requestLog,
    });

    registerCleanup(() => {
        void proxy.close();
        server?.stop();
    });

    const lanIp = detectLanAddresses()[0] ?? 'localhost';

    terminal.line(`iOS selective MITM proxy listening on ${lanIp}:${proxy.port}`);
    terminal.line(
        `Intercepting ONLY ${proxy.targetHost} → ${settings.local} (other domains pass through)`,
    );
    terminal.line(`Install CA on iPhone (once): http://${lanIp}:${proxy.port}/`);
    terminal.line(renderQrTerminal(`http://${lanIp}:${proxy.port}/webview-lens.mobileconfig`));
    terminal.line(
        `Set iPhone Wi-Fi HTTP Proxy → Manual: Server ${lanIp}, Port ${proxy.port}. Ctrl+C exits.`,
    );
    terminal.line(
        'The iPhone and this computer must be on the same Wi-Fi (USB carries only the inspector).',
    );
    watchNetwork(lanIp, proxy);

    if (!ctx.logsEnabled) return forever();

    await ensureIosProxy();

    return runTelemetryLoop({
        streamLogs: true,
        waitTarget: () =>
            driver.waitForTarget(
                (t) =>
                    t.type === 'page' &&
                    (cfg.match ? t.url.includes(cfg.match) : t.url.startsWith(remoteOrigin)),
                ctx.targetOptions,
            ),
        attach: async (target) => {
            const session = await driver.connectInspector(target);
            const detach = (await session.attachTelemetry?.(pageLog)) ?? (() => undefined);

            return { closed: session.closed, detach };
        },
    });
};

/** Forwards each separate HMR port to the phone once (`adb reverse`), and removes them on exit. */
const createHmrReverser = (serial: string | undefined, hmrPorts: readonly number[]) => {
    const reversed: number[] = [];

    return {
        reverseAll() {
            if (hmrPorts.length === 0) return;

            const deviceRun = createAdbRunner(serial);

            for (const hmrPort of hmrPorts) {
                if (reversed.includes(hmrPort)) continue;
                try {
                    reversePort(hmrPort, hmrPort, deviceRun);
                    reversed.push(hmrPort);
                } catch {
                    // The CDP bridge shim still relays WebSockets on this port.
                }
            }
        },
        removeAll() {
            const deviceRun = createAdbRunner(serial);

            for (const hmrPort of reversed) {
                try {
                    removeReversePort(hmrPort, deviceRun);
                } catch {
                    // Best-effort cleanup on exit: the phone may be gone already.
                }
            }
        },
    };
};

const devAndroid = async (ctx: CliContext, settings: DevSettings) => {
    const { cfg, port, isTarget, remoteOrigin } = ctx;
    const server = await ensureServer(settings.local, serverOptions(cfg.cmd));
    const hmr = createHmrReverser(ctx.serial, settings.hmrPorts);

    if (server || settings.hmrPorts.length > 0) {
        registerCleanup(() => {
            hmr.removeAll();
            server?.stop();
        });
    }

    logAdbPath();
    terminal.line(`Preset: ${settings.presetName} (ws: ${settings.wsPrefixes.join(', ')})`);

    const link = startDevtoolsLink({
        port: ctx.linkPort,
        devtoolsPort: port,
        isTarget,
        log: terminal.error,
    });
    let session: OverrideSession | undefined;

    readline.createInterface({ input: process.stdin }).on('line', () => {
        session?.reload().catch((error: unknown) => {
            terminal.error(`Reload failed: ${errorMessage(error)}`);
        });
    });

    for (;;) {
        const page = await waitForPage(port, isTarget, ctx.targetOptions);
        const remote = remoteOrigin ?? new URL(page.url).origin;

        hmr.reverseAll();
        terminal.line(`WebView: ${page.title} (${remote})`);
        terminal.line(`DevTools of the phone: ${link.url}, open it in Chrome`);
        try {
            session = await startOverride({
                page,
                remote,
                local: settings.local,
                ...basePathOptions(cfg),
                wsPrefixes: settings.wsPrefixes,
                quietPrefixes: settings.quietPrefixes,
                ...(settings.hmrPorts.length ? { hmrPorts: settings.hmrPorts } : {}),
                ssePolicy: cfg.sse ?? 'fail',
                forwardedHeaders: Boolean(cfg.forwarded),
                telemetry: ctx.logsEnabled ? pageLog : false,
                logger: requestLog,
            });
            terminal.line(
                `Override on: ${remote} → ${settings.local}. Enter reloads the page, Ctrl+C exits.`,
            );
            // Follow the app: a WebView recreated on rotation or a new screen takes over, and the
            // one we hold stays alive but hidden.
            const watch = new AbortController();
            const otherOnScreen = waitForOtherPageOnScreen(port, page.id, isTarget, {
                signal: watch.signal,
            });

            // Aborted once the race is decided: that rejection is expected, not an error.
            otherOnScreen.catch(() => undefined);

            const outcome = await Promise.race([
                session.closed.then(() => 'closed' as const),
                otherOnScreen,
            ]).finally(() => watch.abort());

            session.close();
            session = undefined;
            terminal.line(
                outcome === 'closed'
                    ? 'The WebView page closed, waiting for a new one…'
                    : `Another WebView is on screen now (${outcome.url}), switching to it…`,
            );
        } catch (error) {
            session = undefined;
            terminal.error(errorMessage(error));
            await sleep(2000);
        }
    }
};

export const dev = async (ctx: CliContext): Promise<void> => {
    const driver = await ctx.selectDriver();
    const settings = devSettings(ctx);

    if (ctx.loadedConfig.path) terminal.line(`Config: ${ctx.loadedConfig.path}`);
    if (driver.platform === 'ios') return devIos(ctx, driver, settings);

    return devAndroid(ctx, settings);
};
