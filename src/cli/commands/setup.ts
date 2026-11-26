// Setup commands: `doctor` (what blocks the connection), `cert` (iOS Root CA profile), `init`.

import { defaultCertDir, ensureRootCa } from '../../node/drivers/ios/certs.ts';
import { writeStarterConfig } from '../../node/config.ts';
import { detectLanAddresses, startIosMitmProxy } from '../../node/drivers/ios/mitm-proxy.ts';
import { renderQrTerminal } from '../../node/qr.ts';
import type { CliContext } from '../context.ts';
import { forever, registerCleanup } from '../runtime.ts';
import { requestLog, terminal } from '../output.ts';

export const doctor = async (ctx: CliContext): Promise<void> => {
    const driver = await ctx.selectDriver();
    const port = ctx.portFor(driver.platform);
    const report = await driver.doctor({ ...(port ? { port } : {}), ...ctx.targetOptions });

    for (const check of report.checks) {
        terminal.line(`${check.ok ? '✓' : '✗'} ${check.message}`);
    }
    for (const target of report.targets) {
        terminal.line(`    ${target.type} ${target.url}`);
    }
};

export const cert = async (ctx: CliContext): Promise<void> => {
    const certDir = defaultCertDir();
    const proxy = await startIosMitmProxy({
        remote: ctx.remoteOrigin ?? 'https://webview-lens.local',
        local: 'http://127.0.0.1:3000',
        port: ctx.proxyPort,
        logger: requestLog,
        ca: ensureRootCa(certDir),
    });

    registerCleanup(() => {
        void proxy.close();
    });

    const lanIp = detectLanAddresses()[0] ?? 'localhost';
    const profileUrl = `http://${lanIp}:${proxy.port}/webview-lens.mobileconfig`;

    terminal.line(`Root CA stored in: ${certDir}`);
    terminal.line(`Open on your iPhone in Safari: http://${lanIp}:${proxy.port}/`);
    terminal.line(`Direct profile URL:            ${profileUrl}`);
    terminal.line('');
    terminal.line(renderQrTerminal(profileUrl));
    terminal.line('');
    terminal.line(
        'After installing, enable trust in: Settings → General → About → Certificate Trust Settings. Ctrl+C exits.',
    );

    return forever();
};

export const init = async ({ values }: CliContext): Promise<void> => {
    const written = writeStarterConfig({
        ...(values.config ? { configPath: values.config } : {}),
        force: values.force,
        ...(values.remote ? { remote: values.remote } : {}),
        ...(values.app ? { app: values.app } : {}),
    });

    terminal.line(`Created ${written}`);
    terminal.line('Next steps:');
    terminal.line('  1. npx webview-lens doctor');
    terminal.line('  2. npx webview-lens dev');
};
