// `webview-lens devtools`: Chrome DevTools of the WebView page at a fixed http://localhost:3300.

import { connectCdp } from '../../node/cdp.ts';
import { waitForPage } from '../../node/device.ts';
import { startDevtoolsLink } from '../../node/devtools-link.ts';
import { startIosDevtoolsLink } from '../../node/drivers/ios/devtools-bridge.ts';
import type { DeviceDriver } from '../../node/drivers/types.ts';
import { attachTelemetry } from '../../node/telemetry.ts';
import type { CliContext } from '../context.ts';
import { ensureIosProxy, logAdbPath, runTelemetryLoop } from '../runtime.ts';

const devtoolsIos = async (ctx: CliContext, driver: DeviceDriver) => {
    const { cfg, remoteOrigin, targetOptions } = ctx;

    await ensureIosProxy();

    const matchesIosTarget = (t: { type: string; url: string }) => {
        if (t.type !== 'page') return false;
        if (cfg.match) return t.url.includes(cfg.match);

        return remoteOrigin ? true : t.url.startsWith('https://');
    };
    const link = startIosDevtoolsLink({
        port: ctx.linkPort,
        resolveTarget: async () =>
            (await driver.listTargets(targetOptions))?.find(matchesIosTarget),
    });

    console.log(`iOS DevTools (WIP↔CDP bridge): ${link.url}, open it in Chrome. Ctrl+C exits.`);

    return runTelemetryLoop({
        streamLogs: ctx.logsEnabled,
        waitTarget: () => driver.waitForTarget(matchesIosTarget, targetOptions),
        onTarget: (target) => console.log(`iOS WKWebView: ${target.title} (${target.url})`),
        attach: async (target) => {
            const session = await driver.connectInspector(target);
            const detach = (await session.attachTelemetry?.()) ?? (() => undefined);

            return { closed: session.closed, detach };
        },
    });
};

const devtoolsAndroid = async (ctx: CliContext) => {
    const { port, isTarget, targetOptions } = ctx;

    logAdbPath();

    const link = startDevtoolsLink({ port: ctx.linkPort, devtoolsPort: port, isTarget });

    console.log(`DevTools of the phone: ${link.url}, open it in Chrome. Ctrl+C exits.`);

    // Keeps the forward fresh across app restarts; the link server reads /json/list on each open.
    return runTelemetryLoop({
        streamLogs: ctx.logsEnabled,
        waitTarget: () => waitForPage(port, isTarget, targetOptions),
        attach: async (page) => {
            const cdp = await connectCdp(page.webSocketDebuggerUrl);
            const detach = attachTelemetry(cdp);

            await cdp.send('Runtime.enable');
            await cdp.send('Network.enable');

            return { closed: cdp.closed, detach };
        },
    });
};

export const devtools = async (ctx: CliContext): Promise<void> => {
    const driver = await ctx.selectDriver();

    if (driver.platform === 'ios') return devtoolsIos(ctx, driver);

    return devtoolsAndroid(ctx);
};
