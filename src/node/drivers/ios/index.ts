// iOS implementation of DeviceDriver and InspectorSession over usbmuxd + IWDP + WIP↔CDP bridge.

import { sleep } from '../../../shared/utils.ts';
import { type Cdp, connectCdp, connectWebKitInspector } from '../../cdp.ts';
import { createProtocolInspectorSession } from '../base-session.ts';
import type {
    ConnectedDevice,
    DeviceDriver,
    DoctorCheck,
    DoctorReport,
    DriverTargetOptions,
    InspectableTarget,
    InspectorCapabilities,
    InspectorSession,
    TargetPredicate,
} from '../types.ts';
import {
    findIwdp,
    type IwdpDeviceEntry,
    type IwdpPage,
    listIwdpDevices,
    listIwdpPages,
} from './iwdp.ts';
import { describeIosDevices, listIosDevices } from './usbmux.ts';
import { createWipCdpBridge } from './wip-cdp-bridge.ts';

/** Honest capabilities of iOS WKWebView (WebKit lacks CDP Fetch and several Web Vitals). */
const IOS_CAPABILITIES: InspectorCapabilities = {
    lcp: false,
    cls: false,
    inp: false,
    cdpFetchOverride: false,
};

export const iwdpPageToTarget = (page: IwdpPage, index: number): InspectableTarget => ({
    id: page.id ?? `ios-page-${index + 1}`,
    platform: 'ios',
    type: 'page',
    url: page.url,
    title: page.title,
    debuggerUrl: page.webSocketDebuggerUrl ?? '',
    ...(page.devtoolsFrontendUrl ? { frontendUrl: page.devtoolsFrontendUrl } : {}),
});

/** Wraps a raw WebKit Inspector Protocol socket into the unified InspectorSession contract. */
export const createIosInspectorSession = (rawWip: Cdp): InspectorSession =>
    createProtocolInspectorSession(createWipCdpBridge(rawWip), {
        platform: 'ios',
        capabilities: IOS_CAPABILITIES,
        enableTelemetry: async () => {
            await rawWip.send('Console.enable').catch(() => undefined);
            await rawWip.send('Runtime.enable').catch(() => undefined);
            await rawWip.send('Network.enable').catch(() => undefined);
        },
    });

export interface IosDriverDeps {
    platform?: string;
    controlPort?: number | string;
    defaultDevicePort?: number | string;
    listIosDevices?: typeof listIosDevices;
    findIwdp?: typeof findIwdp;
    listIwdpDevices?: typeof listIwdpDevices;
    listIwdpPages?: typeof listIwdpPages;
    connectWip?: typeof connectCdp;
}

const parsePortFromIwdpUrl = (url: string, fallback: number | string): string => {
    const match = url.match(/:(\d+)$/);

    return match?.[1] ?? String(fallback);
};

/** Creates a cross-platform (macOS + Windows) iOS DeviceDriver. */
export const createIosDriver = (deps: IosDriverDeps = {}): DeviceDriver => {
    const hostPlatform = deps.platform ?? process.platform;
    const controlPort = deps.controlPort ?? 9221;
    const defaultDevicePort = deps.defaultDevicePort ?? 9222;
    const listIosDevicesFn = deps.listIosDevices ?? listIosDevices;
    const findIwdpFn = deps.findIwdp ?? findIwdp;
    const listIwdpDevicesFn = deps.listIwdpDevices ?? listIwdpDevices;
    const listIwdpPagesFn = deps.listIwdpPages ?? listIwdpPages;
    const connectWipFn = deps.connectWip ?? connectWebKitInspector;

    const resolveIwdpDevice = async (
        serial?: string,
    ): Promise<{ entry?: IwdpDeviceEntry; port: string }> => {
        const entries = await listIwdpDevicesFn(controlPort);

        if (!entries || entries.length === 0) {
            return { port: String(defaultDevicePort) };
        }
        const matched = serial ? entries.find((e) => e.deviceId === serial) : entries[0];

        return matched
            ? { entry: matched, port: parsePortFromIwdpUrl(matched.url, defaultDevicePort) }
            : { port: String(defaultDevicePort) };
    };

    const listDevices = async (): Promise<ConnectedDevice[]> => {
        const status = await listIosDevicesFn({ platform: hostPlatform });

        if (!status.available) return [];

        return status.devices.map((device) => ({
            id: device.udid,
            platform: 'ios',
            state: 'connected',
        }));
    };

    const listTargets = async (
        options: DriverTargetOptions = {},
    ): Promise<InspectableTarget[] | null> => {
        const { port } = options.port
            ? { port: String(options.port) }
            : await resolveIwdpDevice(options.serial);
        const pages = await listIwdpPagesFn(port);

        if (!pages) return null;

        const filtered = options.app
            ? pages.filter((p) => !p.appId || p.appId === options.app)
            : pages;

        return filtered
            .filter((p) => Boolean(p.webSocketDebuggerUrl))
            .map((p, index) => iwdpPageToTarget(p, index));
    };

    const diagnose = async (options: DriverTargetOptions = {}): Promise<string> => {
        const status = await listIosDevicesFn({ platform: hostPlatform });
        const problem = describeIosDevices(status, options.serial, hostPlatform);

        if (problem) return problem;

        const { iwdp } = findIwdpFn({ platform: hostPlatform });
        const targets = await listTargets(options);

        if (targets === null) {
            return iwdp
                ? `ios_webkit_debug_proxy is not running on :${controlPort}: start "${iwdp}"`
                : 'ios_webkit_debug_proxy not found: install it (brew install ios-webkit-debug-proxy on macOS, scoop install ios-webkit-debug-proxy on Windows) and run it';
        }
        if (targets.length === 0) {
            return 'No inspectable WKWebView: enable Settings → Safari → Advanced → Web Inspector on iPhone and ensure the test build sets webView.isInspectable = true';
        }

        return `Found ${targets.length} iOS WebView page(s); waiting for one matching the filter`;
    };

    return {
        platform: 'ios',
        listDevices,
        isAvailable: async () => (await listDevices()).length > 0,
        diagnose,
        async doctor(options: DriverTargetOptions = {}): Promise<DoctorReport> {
            const checks: DoctorCheck[] = [];
            const status = await listIosDevicesFn({ platform: hostPlatform });
            const usbProblem = describeIosDevices(status, options.serial, hostPlatform);

            checks.push({
                ok: !usbProblem,
                message:
                    usbProblem ??
                    `iPhone connected over usbmuxd (${[...new Set(status.devices.map((d) => d.udid))].join(', ')})`,
            });
            if (usbProblem) return { platform: 'ios', checks, targets: [] };

            const { iwdp, checked } = findIwdpFn({ platform: hostPlatform });

            checks.push({
                ok: Boolean(iwdp),
                message: iwdp
                    ? `ios_webkit_debug_proxy: ${iwdp}`
                    : `ios_webkit_debug_proxy not found, looked in: ${checked.join('; ')}`,
            });

            const targets = await listTargets(options);

            checks.push({
                ok: Boolean(targets && targets.length > 0),
                message:
                    targets === null
                        ? `ios_webkit_debug_proxy does not answer on :${controlPort} (start it with "ios_webkit_debug_proxy")`
                        : targets.length > 0
                          ? `inspectable WKWebView pages: ${targets.length}`
                          : 'no inspectable WKWebView pages (enable Web Inspector on iPhone and webView.isInspectable = true)',
            });

            return { platform: 'ios', checks, targets: targets ?? [] };
        },
        listTargets,
        async waitForTarget(
            predicate: TargetPredicate,
            options: DriverTargetOptions = {},
        ): Promise<InspectableTarget> {
            const log = options.log ?? console.log;
            const intervalMs = options.intervalMs ?? 2000;
            let lastHint = '';

            for (;;) {
                options.signal?.throwIfAborted();

                const target = (await listTargets(options))?.find(predicate);

                if (target) return target;

                const hint = await diagnose(options);

                if (hint !== lastHint) log(`… ${hint}`);
                lastHint = hint;
                await sleep(intervalMs);
            }
        },
        async getDeviceDescription(options: DriverTargetOptions = {}): Promise<string> {
            const { entry } = await resolveIwdpDevice(options.serial);

            return entry?.deviceName
                ? `${entry.deviceName} (iOS WKWebView)`
                : 'iPhone (iOS WKWebView)';
        },
        async connectInspector(target: InspectableTarget): Promise<InspectorSession> {
            if (!target.debuggerUrl) {
                throw new Error(`iOS target "${target.url}" has no WebSocket debugger URL`);
            }

            const rawWip = await connectWipFn(target.debuggerUrl);

            await rawWip.send('Page.enable').catch(() => undefined);
            await rawWip.send('Network.enable').catch(() => undefined);

            return createIosInspectorSession(rawWip);
        },
    };
};
