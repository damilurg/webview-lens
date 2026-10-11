// Android implementation of DeviceDriver and InspectorSession over ADB + Chrome DevTools Protocol.

import {
    AdbNotFoundError,
    type AdbRunner,
    createAdbRunner,
    describeDevices,
    findAdb,
    isKeyguardShowing,
    parseDevices,
    parseFocusedPackage,
    parseWebViewSockets,
    runAdb,
} from '../adb.ts';
import { type Cdp, connectCdp, type DevtoolsPage, getVersion, listPages } from '../cdp.ts';
import { diagnose, waitForPage } from '../device.ts';
import { attachTelemetry, type TelemetryOptions } from '../telemetry.ts';
import type {
    ConnectedDevice,
    DeviceDriver,
    DoctorCheck,
    DoctorReport,
    DriverTargetOptions,
    InspectableTarget,
    InspectorCapabilities,
    InspectorSession,
    NavigateOptions,
    TargetPredicate,
} from './types.ts';

const waitWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            promise,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ANDROID_CAPABILITIES: InspectorCapabilities = {
    lcp: true,
    cls: true,
    inp: true,
    cdpFetchOverride: true,
};

export const pageToTarget = (page: DevtoolsPage): InspectableTarget => ({
    id: page.id,
    platform: 'android',
    type: page.type,
    url: page.url,
    title: page.title,
    debuggerUrl: page.webSocketDebuggerUrl,
    ...(page.devtoolsFrontendUrl ? { frontendUrl: page.devtoolsFrontendUrl } : {}),
});

/** Wraps a raw CDP connection in the platform-agnostic InspectorSession contract. */
export const createCdpInspectorSession = (cdp: Cdp): InspectorSession => ({
    platform: 'android',
    capabilities: ANDROID_CAPABILITIES,
    async evaluate<T = unknown>(expression: string): Promise<T> {
        const { result } = await cdp.send<{ result: { value?: T } }>('Runtime.evaluate', {
            expression,
            returnByValue: true,
        });

        return result.value as T;
    },
    async addInitScript(source: string): Promise<void> {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async navigate(
        url: string,
        { waitForLoad = false, timeoutMs = 30_000 }: NavigateOptions = {},
    ): Promise<void> {
        if (!waitForLoad) {
            await cdp.send('Page.navigate', { url });

            return;
        }

        const loaded = cdp.once('Page.loadEventFired');

        await cdp.send('Page.navigate', { url });
        await waitWithTimeout(loaded, timeoutMs);
    },
    async reload({ ignoreCache = false }: { ignoreCache?: boolean } = {}): Promise<void> {
        await cdp.send('Page.reload', { ignoreCache });
    },
    async setCacheDisabled(disabled: boolean): Promise<void> {
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: disabled });
    },
    async attachTelemetry(options?: TelemetryOptions): Promise<() => void> {
        const detach = attachTelemetry(cdp, options);

        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');

        return detach;
    },
    close: () => cdp.close(),
    closed: cdp.closed,
});

export interface AndroidDriverDeps {
    findAdb?: typeof findAdb;
    runAdb?: AdbRunner;
    listPages?: typeof listPages;
    getVersion?: typeof getVersion;
    connectCdp?: typeof connectCdp;
    defaultPort?: string | number;
}

/** Creates an Android DeviceDriver backed by ADB and CDP. */
export const createAndroidDriver = (deps: AndroidDriverDeps = {}): DeviceDriver => {
    const findAdbFn = deps.findAdb ?? findAdb;
    const runAdbFn = deps.runAdb ?? runAdb;
    const listPagesFn = deps.listPages ?? listPages;
    const getVersionFn = deps.getVersion ?? getVersion;
    const connectCdpFn = deps.connectCdp ?? connectCdp;
    const defaultPort = deps.defaultPort ?? '9223';

    const listDevices = (): ConnectedDevice[] => {
        try {
            if (!findAdbFn().adb) return [];

            return parseDevices(runAdbFn(['devices'])).map(({ serial, state }) => ({
                id: serial,
                platform: 'android',
                state,
            }));
        } catch {
            return [];
        }
    };

    return {
        platform: 'android',
        listDevices,
        isAvailable: () => listDevices().some((d) => d.state === 'device'),
        async diagnose(options: DriverTargetOptions = {}): Promise<string> {
            return diagnose(options.port ?? defaultPort, runAdbFn, {
                ...(options.serial ? { serial: options.serial } : {}),
                ...(options.app ? { app: options.app } : {}),
            });
        },
        async doctor(options: DriverTargetOptions = {}): Promise<DoctorReport> {
            const port = options.port ?? defaultPort;
            const checks: DoctorCheck[] = [];
            const { adb, checked } = findAdbFn();

            if (!adb) {
                checks.push({
                    ok: false,
                    message: `adb not found, looked in: ${checked.join('; ')}`,
                });

                return { platform: 'android', checks, targets: [] };
            }
            checks.push({ ok: true, message: `adb: ${adb}` });

            try {
                const devicesProblem = describeDevices(runAdbFn(['devices']), options.serial);

                checks.push({
                    ok: !devicesProblem,
                    message: devicesProblem ?? 'phone connected, debugging allowed',
                });
                if (devicesProblem) return { platform: 'android', checks, targets: [] };

                const deviceRun = createAdbRunner(options.serial, runAdbFn);
                const window = deviceRun(['shell', 'dumpsys', 'window']);

                checks.push({
                    ok: !isKeyguardShowing(window),
                    message: isKeyguardShowing(window) ? 'screen locked' : 'screen unlocked',
                });
                checks.push({
                    ok: true,
                    message: `app on screen: ${parseFocusedPackage(window) ?? 'unknown'}`,
                });

                const sockets = parseWebViewSockets(deviceRun(['shell', 'cat', '/proc/net/unix']));

                checks.push({
                    ok: sockets.length > 0,
                    message: `debuggable WebViews: ${sockets.join(', ') || 'none'}`,
                });
            } catch (error) {
                checks.push({
                    ok: false,
                    message:
                        error instanceof AdbNotFoundError
                            ? 'adb not found'
                            : `adb: ${errorMessage(error)}`,
                });

                return { platform: 'android', checks, targets: [] };
            }

            const pages = await listPagesFn(port);
            const targets = (pages ?? []).map(pageToTarget);

            checks.push({
                ok: Boolean(pages),
                message: pages
                    ? `port ${port}: ${pages.length} page(s)`
                    : `port ${port}: no answer (run dev, devtools or vitals to forward it)`,
            });

            return { platform: 'android', checks, targets };
        },
        async listTargets(options: DriverTargetOptions = {}): Promise<InspectableTarget[] | null> {
            const pages = await listPagesFn(options.port ?? defaultPort);

            return pages ? pages.map(pageToTarget) : null;
        },
        async waitForTarget(
            predicate: TargetPredicate,
            options: DriverTargetOptions = {},
        ): Promise<InspectableTarget> {
            const page = await waitForPage(
                options.port ?? defaultPort,
                (p) => predicate(pageToTarget(p)),
                {
                    run: runAdbFn,
                    ...(options.log ? { log: options.log } : {}),
                    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
                    ...(options.serial ? { serial: options.serial } : {}),
                    ...(options.app ? { app: options.app } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                },
            );

            return pageToTarget(page);
        },
        async getDeviceDescription(options: DriverTargetOptions = {}): Promise<string> {
            const version = await getVersionFn(options.port ?? defaultPort);

            return String(version['User-Agent'] ?? version.Browser ?? 'unknown');
        },
        async connectInspector(target: InspectableTarget): Promise<InspectorSession> {
            const cdp = await connectCdpFn(target.debuggerUrl);

            await cdp.send('Page.enable');
            await cdp.send('Network.enable');

            return createCdpInspectorSession(cdp);
        },
    };
};
