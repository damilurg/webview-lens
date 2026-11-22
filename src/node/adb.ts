// adb: where to find it, how to read the phone's state, and the port forward to the WebView DevTools.
//
// The DevTools socket of a WebView is `webview_devtools_remote_<pid>`. After the app restarts the pid
// is new and an old `adb forward` leads nowhere, so the socket is looked up again
// (`adb shell cat /proc/net/unix`) and the port is forwarded to it.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { findFileInDirs, isFile } from './fs-utils.ts';

export interface FindAdbOptions {
    env?: Record<string, string | undefined>;
    home?: string;
    platform?: string;
}

export interface FindAdbResult {
    adb: string | undefined;
    /** Places looked at, for a hint when adb is nowhere. */
    checked: string[];
}

/**
 * adb without setup, in this order: `ADB`, `ANDROID_HOME` / `ANDROID_SDK_ROOT`, the default Android SDK,
 * `PATH`, an unpacked platform-tools archive in Downloads.
 */
export const findAdb = ({
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
}: FindAdbOptions = {}): FindAdbResult => {
    const adbFile = platform === 'win32' ? 'adb.exe' : 'adb';
    const defaultSdk =
        platform === 'win32'
            ? path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk')
            : path.join(home, platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
    const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaultSdk].filter(
        (root): root is string => Boolean(root),
    );
    const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
    const downloads = path.join(home, 'Downloads');
    const checked: string[] = [];

    if (env.ADB) {
        checked.push(`ADB=${env.ADB}`);
        if (isFile(env.ADB)) return { adb: env.ADB, checked };
    }
    for (const file of [
        ...sdkRoots.map((root) => path.join(root, 'platform-tools', adbFile)),
        ...pathDirs.map((dir) => path.join(dir, adbFile)),
    ]) {
        if (isFile(file)) return { adb: file, checked };
    }
    checked.push('ANDROID_HOME, ANDROID_SDK_ROOT, Android SDK, PATH');

    const fromDownloads = findFileInDirs(downloads, ['platform-tools', adbFile], 2);

    checked.push(`${downloads} (platform-tools)`);

    return { adb: fromDownloads, checked };
};

export class AdbNotFoundError extends Error {
    readonly checked: string[];

    constructor(checked: string[]) {
        super('adb not found');
        this.name = 'AdbNotFoundError';
        this.checked = checked;
    }
}

let resolved: string | undefined;

/** Path to adb, found once per process. Throws AdbNotFoundError. */
export const resolveAdb = (onFound?: (adbPath: string) => void): string => {
    if (resolved) return resolved;

    const { adb, checked } = findAdb();

    if (!adb) throw new AdbNotFoundError(checked);
    resolved = adb;
    onFound?.(adb);

    return adb;
};

/** Runs adb and returns stdout. */
export type AdbRunner = (args: string[]) => string;

export const runAdb: AdbRunner = (args) =>
    execFileSync(resolveAdb(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Wraps an AdbRunner to target a specific device via `-s <serial>` (except global `adb devices`). */
export const createAdbRunner = (serial?: string, baseRun: AdbRunner = runAdb): AdbRunner => {
    if (!serial) return baseRun;

    return (args) => (args[0] === 'devices' ? baseRun(args) : baseRun(['-s', serial, ...args]));
};

export interface AdbDevice {
    serial: string;
    state: string;
}

/** Connected devices from `adb devices`. */
export const parseDevices = (output: string): AdbDevice[] =>
    output
        .split(/\r?\n/)
        .slice(1)
        .flatMap((line) => {
            const [serial, state] = line.trim().split(/\s+/);

            return serial && state ? [{ serial, state }] : [];
        });

/**
 * Package of the app on screen, from `dumpsys window`: the focused app (mFocusedApp), which the
 * notification shade and system windows do not override; otherwise the focused window (mCurrentFocus).
 */
export const parseFocusedPackage = (dumpsysOutput: string): string | undefined =>
    dumpsysOutput.match(/mFocusedApp=ActivityRecord\{[^}]*?\s([\w.]+)\/[^}\s]+/)?.[1] ??
    dumpsysOutput.match(/mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/[^}\s]+\}/)?.[1];

/** Process names by pid, from `ps -A -o PID,NAME`. */
export const parsePackagesByPid = (psOutput: string): Map<number, string> =>
    new Map(
        psOutput.split(/\r?\n/).flatMap((line) => {
            const [pid, name] = line.trim().split(/\s+/);

            return pid && name && /^\d+$/.test(pid) ? [[Number(pid), name] as const] : [];
        }),
    );

/** WebView DevTools socket names from `cat /proc/net/unix`. */
export const parseWebViewSockets = (unixOutput: string): string[] => [
    ...new Set(unixOutput.match(/webview_devtools_remote_\d+/g) ?? []),
];

/**
 * The socket to attach to: an explicitly pinned `preferredPackage` (if given), otherwise the WebView
 * of the app on screen (a debug and a release build can both hold a WebView), otherwise the newest process.
 */
export const pickWebViewSocket = (
    socketNames: readonly string[],
    focusedPackage: string | undefined,
    packagesByPid: ReadonlyMap<number, string>,
    preferredPackage?: string,
): string | undefined => {
    const sockets = [...new Set(socketNames)]
        .map((name) => ({ name, pid: Number(name.split('_').at(-1)) }))
        .sort((a, b) => b.pid - a.pid);

    if (preferredPackage) {
        return sockets.find(({ pid }) => packagesByPid.get(pid) === preferredPackage)?.name;
    }

    const onScreen = sockets.find(({ pid }) => packagesByPid.get(pid) === focusedPackage);

    return (onScreen ?? sockets[0])?.name;
};

export interface ForwardWebViewOptions {
    /** Pin discovery to a specific Android package name (e.g. `com.example.app.debug`). */
    app?: string;
}

/**
 * Forwards `localhost:port` to the DevTools socket of the WebView on screen (or the pinned `app`).
 * Returns the socket name, or null when no matching WebView with debugging enabled is running.
 */
export const forwardWebView = (
    port: string | number,
    run: AdbRunner = runAdb,
    options: ForwardWebViewOptions = {},
): string | null => {
    const sockets = parseWebViewSockets(run(['shell', 'cat', '/proc/net/unix']));

    if (sockets.length === 0) return null;

    const socket = pickWebViewSocket(
        sockets,
        options.app ? undefined : parseFocusedPackage(run(['shell', 'dumpsys', 'window'])),
        parsePackagesByPid(run(['shell', 'ps', '-A', '-o', 'PID,NAME'])),
        options.app,
    );

    if (!socket) return null;

    run(['forward', `tcp:${port}`, `localabstract:${socket}`]);

    return socket;
};

/** Exposes a local TCP port on the phone via `adb reverse` (useful for separate HMR ports). */
export const reversePort = (
    remotePort: string | number,
    localPort: string | number = remotePort,
    run: AdbRunner = runAdb,
): void => {
    run(['reverse', `tcp:${remotePort}`, `tcp:${localPort}`]);
};

/** Removes a previously created `adb reverse` rule for the given port. */
export const removeReversePort = (remotePort: string | number, run: AdbRunner = runAdb): void => {
    run(['reverse', '--remove', `tcp:${remotePort}`]);
};

/**
 * What blocks work with the phone, from `adb devices`: a hint for a person, or null when the
 * target phone is connected and allowed debugging.
 */
export const describeDevices = (output: string, serial?: string): string | null => {
    const devices = parseDevices(output);

    if (devices.length === 0) {
        return 'No phone found: connect it over USB and turn on USB debugging (Settings → Developer options)';
    }

    if (serial) {
        const match = devices.find((device) => device.serial === serial);

        if (!match) {
            return `Phone "${serial}" not found (connected: ${devices.map((d) => d.serial).join(', ')})`;
        }
        if (match.state === 'device') return null;
        if (match.state === 'unauthorized') {
            return `Phone "${serial}" has not allowed debugging: confirm "Allow USB debugging" on its screen`;
        }

        return `Phone "${serial}" is "${match.state}": reconnect the cable`;
    }

    const online = devices.filter((device) => device.state === 'device');

    if (online.length === 1) return null;
    if (online.length > 1) {
        return `Multiple phones connected (${online.map((d) => d.serial).join(', ')}): pass --serial <id>`;
    }
    if (devices.some((device) => device.state === 'unauthorized')) {
        return 'The phone has not allowed debugging: confirm "Allow USB debugging" on its screen';
    }

    return `The phone is "${devices[0]?.state ?? 'unknown'}": reconnect the cable`;
};

/** Whether the screen is locked, from `dumpsys window`: a locked WebView does not render. */
export const isKeyguardShowing = (dumpsysOutput: string): boolean =>
    /isKeyguardShowing=true|mDreamingLockscreen=true/.test(dumpsysOutput);
