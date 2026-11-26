// Android implementation of DeviceDriver and InspectorSession over ADB + Chrome DevTools Protocol.

import { errorMessage } from '../../shared/utils.ts';
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
import { decodePerformanceMetrics } from '../protocol.ts';
import { createProtocolInspectorSession } from './base-session.ts';
import type {
    ConnectedDevice,
    DeviceDriver,
    DoctorCheck,
    DoctorReport,
    DriverTargetOptions,
    InspectableTarget,
    InspectorCapabilities,
    InspectorSession,
    NetworkThrottlePreset,
    NetworkThrottleProfile,
    TargetPredicate,
} from './types.ts';

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

export const NETWORK_THROTTLE_PROFILES: Readonly<
    Record<NetworkThrottlePreset, NetworkThrottleProfile>
> = {
    none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    'fast-4g': {
        offline: false,
        latency: 40,
        downloadThroughput: 1_800_000,
        uploadThroughput: 750_000,
    },
    'slow-4g': {
        offline: false,
        latency: 150,
        downloadThroughput: 204_800,
        uploadThroughput: 96_000,
    },
    '3g': { offline: false, latency: 300, downloadThroughput: 93_750, uploadThroughput: 31_250 },
};

/** Wraps a raw CDP connection in the platform-agnostic InspectorSession contract. */
export const createCdpInspectorSession = (cdp: Cdp): InspectorSession => {
    let perfEnabled = false;
    const base = createProtocolInspectorSession(cdp, {
        platform: 'android',
        capabilities: ANDROID_CAPABILITIES,
        enableTelemetry: async () => {
            await cdp.send('Runtime.enable');
            await cdp.send('Network.enable');
        },
    });

    return {
        ...base,
        async setNetworkThrottle(preset: NetworkThrottlePreset): Promise<void> {
            await cdp.send('Network.emulateNetworkConditions', NETWORK_THROTTLE_PROFILES[preset]);
        },
        async setCpuThrottle(rate: number): Promise<void> {
            await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        },
        async getMemoryUsageMb(): Promise<number | null> {
            try {
                if (!perfEnabled) {
                    await cdp.send('Performance.enable');
                    perfEnabled = true;
                }
                const metrics = decodePerformanceMetrics(await cdp.send('Performance.getMetrics'));
                const used = metrics?.get('JSHeapUsedSize');

                return used === undefined ? null : Math.round((used / (1024 * 1024)) * 10) / 10;
            } catch {
                return null;
            }
        },
    };
};

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
        async diagnose({
            port = defaultPort,
            serial,
            app,
        }: DriverTargetOptions = {}): Promise<string> {
            return diagnose(port, runAdbFn, {
                ...(serial ? { serial } : {}),
                ...(app ? { app } : {}),
            });
        },
        async doctor({
            port = defaultPort,
            serial,
        }: DriverTargetOptions = {}): Promise<DoctorReport> {
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
                const devicesProblem = describeDevices(runAdbFn(['devices']), serial);

                checks.push({
                    ok: !devicesProblem,
                    message: devicesProblem ?? 'phone connected, debugging allowed',
                });
                if (devicesProblem) return { platform: 'android', checks, targets: [] };

                const deviceRun = createAdbRunner(serial, runAdbFn);
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
        async listTargets({ port = defaultPort }: DriverTargetOptions = {}): Promise<
            InspectableTarget[] | null
        > {
            const pages = await listPagesFn(port);

            return pages ? pages.map(pageToTarget) : null;
        },
        async waitForTarget(
            predicate: TargetPredicate,
            { port = defaultPort, log, intervalMs, serial, app, signal }: DriverTargetOptions = {},
        ): Promise<InspectableTarget> {
            const page = await waitForPage(port, (p) => predicate(pageToTarget(p)), {
                run: runAdbFn,
                listPages: listPagesFn,
                ...(log ? { log } : {}),
                ...(intervalMs !== undefined ? { intervalMs } : {}),
                ...(serial ? { serial } : {}),
                ...(app ? { app } : {}),
                ...(signal ? { signal } : {}),
            });

            return pageToTarget(page);
        },
        async getDeviceDescription({
            port = defaultPort,
        }: DriverTargetOptions = {}): Promise<string> {
            const version = await getVersionFn(port);

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
