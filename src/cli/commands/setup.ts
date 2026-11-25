// Setup commands: `doctor` (what blocks the connection), `cert` (iOS Root CA profile), `init`.

import { defaultCertDir, ensureRootCa } from '../../node/drivers/ios/certs.ts';
import { writeStarterConfig } from '../../node/config.ts';
import { detectLanAddresses, startIosMitmProxy } from '../../node/drivers/ios/mitm-proxy.ts';
import { renderQrTerminal } from '../../node/qr.ts';
import type { CliContext } from '../context.ts';
import { forever, registerCleanup } from '../runtime.ts';

export const doctor = async (ctx: CliContext): Promise<void> => {
    const driver = await ctx.selectDriver();
    const port = ctx.portFor(driver.platform);
    const report = await driver.doctor({ ...(port ? { port } : {}), ...ctx.targetOptions });

    for (const check of report.checks) {
        console.log(`${check.ok ? '✓' : '✗'} ${check.message}`);
    }
    for (const target of report.targets) {
        console.log(`    ${target.type} ${target.url}`);
    }
};

export const cert = async (ctx: CliContext): Promise<void> => {
    const certDir = defaultCertDir();
    const proxy = await startIosMitmProxy({
        remote: ctx.remoteOrigin ?? 'https://webview-lens.local',
        local: 'http://127.0.0.1:3000',
        port: ctx.proxyPort,
        ca: ensureRootCa(certDir),
    });

    registerCleanup(() => {
        void proxy.close();
    });

    const lanIp = detectLanAddresses()[0] ?? 'localhost';
    const profileUrl = `http://${lanIp}:${proxy.port}/webview-lens.mobileconfig`;

    console.log(`Root CA stored in: ${certDir}`);
    console.log(`Open on your iPhone in Safari: http://${lanIp}:${proxy.port}/`);
    console.log(`Direct profile URL:            ${profileUrl}`);
    console.log('');
    console.log(renderQrTerminal(profileUrl));
    console.log('');
    console.log(
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

    console.log(`Created ${written}`);
    console.log('Next steps:');
    console.log('  1. npx webview-lens doctor');
    console.log('  2. npx webview-lens dev');
};
