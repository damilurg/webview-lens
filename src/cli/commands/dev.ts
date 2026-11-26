// `webview-lens dev`: the stand's origin served from your local dev server inside the app.
// Android: CDP Fetch interception of the WebView page. iOS: the selective HTTPS MITM proxy.

import readline from 'node:readline';

import { createAdbRunner, removeReversePort, reversePort } from '../../node/adb.ts';
import { waitForOtherPageOnScreen, waitForPage } from '../../node/device.ts';
import { startDevtoolsLink } from '../../node/devtools-link.ts';
import { detectLanAddresses, startIosMitmProxy } from '../../node/drivers/ios/mitm-proxy.ts';
import type { DeviceDriver } from '../../node/drivers/types.ts';
import { type OverrideSession, startOverride } from '../../node/override.ts';
import { resolvePreset } from '../../node/presets.ts';
import { renderQrTerminal } from '../../node/qr.ts';
import { ensureServer } from '../../node/server-process.ts';
import { errorMessage, sleep } from '../../shared/utils.ts';
import type { CliContext } from '../context.ts';
import {
    basePathOptions,
    ensureIosProxy,
    forever,
    logAdbPath,
    registerCleanup,
    runTelemetryLoop,
} from '../runtime.ts';

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
        local: (cfg.local ?? process.env.LOCAL_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
        wsPrefixes: cfg.ws ?? preset.wsPrefixes,
        quietPrefixes: cfg.quiet ?? preset.quietPrefixes,
        hmrPorts: cfg.hmrPorts ?? [],
        presetName: preset.name,
    };
};

const devIos = async (ctx: CliContext, driver: DeviceDriver, settings: DevSettings) => {
    const { cfg, remoteOrigin } = ctx;

    if (!remoteOrigin) {
        throw new Error(
            'iOS `dev` override needs --remote <https://stand.example.com> so the selective MITM proxy knows which host to intercept.',
        );
    }

    const server = await ensureServer(settings.local, cfg.cmd ? { command: cfg.cmd } : {});
    const proxy = await startIosMitmProxy({
        remote: remoteOrigin,
        local: settings.local,
        ...basePathOptions(cfg),
        port: ctx.proxyPort,
        quietPrefixes: settings.quietPrefixes,
        forwardedHeaders: Boolean(cfg.forwarded),
    });

    registerCleanup(() => {
        void proxy.close();
        server?.stop();
    });

    const lanIp = detectLanAddresses()[0] ?? 'localhost';

    console.log(`iOS selective MITM proxy listening on ${lanIp}:${proxy.port}`);
    console.log(
        `Intercepting ONLY ${proxy.targetHost} → ${settings.local} (other domains pass through)`,
    );
    console.log(`Install CA on iPhone (once): http://${lanIp}:${proxy.port}/`);
    console.log(renderQrTerminal(`http://${lanIp}:${proxy.port}/webview-lens.mobileconfig`));
    console.log(
        `Set iPhone Wi-Fi HTTP Proxy → Manual: Server ${lanIp}, Port ${proxy.port}. Ctrl+C exits.`,
    );

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
            const detach = (await session.attachTelemetry?.()) ?? (() => undefined);

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
    const server = await ensureServer(settings.local, cfg.cmd ? { command: cfg.cmd } : {});
    const hmr = createHmrReverser(ctx.serial, settings.hmrPorts);

    if (server || settings.hmrPorts.length > 0) {
        registerCleanup(() => {
            hmr.removeAll();
            server?.stop();
        });
    }

    logAdbPath();
    console.log(`Preset: ${settings.presetName} (ws: ${settings.wsPrefixes.join(', ')})`);

    const link = startDevtoolsLink({ port: ctx.linkPort, devtoolsPort: port, isTarget });
    let session: OverrideSession | undefined;

    readline.createInterface({ input: process.stdin }).on('line', () => {
        session?.reload().catch((error: unknown) => {
            console.error(`Reload failed: ${errorMessage(error)}`);
        });
    });

    for (;;) {
        const page = await waitForPage(port, isTarget, ctx.targetOptions);
        const remote = remoteOrigin ?? new URL(page.url).origin;

        hmr.reverseAll();
        console.log(`WebView: ${page.title} (${remote})`);
        console.log(`DevTools of the phone: ${link.url}, open it in Chrome`);
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
                telemetry: ctx.logsEnabled,
            });
            console.log(
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
            console.log(
                outcome === 'closed'
                    ? 'The WebView page closed, waiting for a new one…'
                    : `Another WebView is on screen now (${outcome.url}), switching to it…`,
            );
        } catch (error) {
            session = undefined;
            console.error(errorMessage(error));
            await sleep(2000);
        }
    }
};

export const dev = async (ctx: CliContext): Promise<void> => {
    const driver = await ctx.selectDriver();
    const settings = devSettings(ctx);

    if (ctx.loadedConfig.path) console.log(`Config: ${ctx.loadedConfig.path}`);
    if (driver.platform === 'ios') return devIos(ctx, driver, settings);

    return devAndroid(ctx, settings);
};
