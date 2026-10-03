// adb: where to find it, how to read the phone's state, and the port forward to the WebView DevTools.
//
// The DevTools socket of a WebView is `webview_devtools_remote_<pid>`. After the app restarts the pid
// is new and an old `adb forward` leads nowhere, so the socket is looked up again
// (`adb shell cat /proc/net/unix`) and the port is forwarded to it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isFile = (file: string): boolean => {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
};

const listDirs = (dir: string): string[] => {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(dir, entry.name));
    } catch {
        return [];
    }
};

/** `platform-tools/adb` inside dir, up to `depth` folders down (Downloads/platform-tools-latest/platform-tools). */
const findPlatformTools = (dir: string, adbFile: string, depth: number): string | undefined => {
    const direct = path.join(dir, 'platform-tools', adbFile);

    if (isFile(direct)) return direct;
    if (depth === 0) return undefined;

    for (const child of listDirs(dir)) {
        const found = findPlatformTools(child, adbFile, depth - 1);

        if (found) return found;
    }

    return undefined;
};

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

    const fromDownloads = findPlatformTools(downloads, adbFile, 2);

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
 * The socket to attach to: the WebView of the app on screen (a debug and a release build can both
 * hold a WebView), otherwise the newest process.
 */
export const pickWebViewSocket = (
    socketNames: readonly string[],
    focusedPackage: string | undefined,
    packagesByPid: ReadonlyMap<number, string>,
): string | undefined => {
    const sockets = [...new Set(socketNames)]
        .map((name) => ({ name, pid: Number(name.split('_').at(-1)) }))
        .sort((a, b) => b.pid - a.pid);
    const onScreen = sockets.find(({ pid }) => packagesByPid.get(pid) === focusedPackage);

    return (onScreen ?? sockets[0])?.name;
};

/**
 * Forwards `localhost:port` to the DevTools socket of the WebView on screen.
 * Returns the socket name, or null when no WebView with debugging enabled is running.
 */
export const forwardWebView = (port: string | number, run: AdbRunner = runAdb): string | null => {
    const sockets = parseWebViewSockets(run(['shell', 'cat', '/proc/net/unix']));

    if (sockets.length === 0) return null;

    const socket = pickWebViewSocket(
        sockets,
        parseFocusedPackage(run(['shell', 'dumpsys', 'window'])),
        parsePackagesByPid(run(['shell', 'ps', '-A', '-o', 'PID,NAME'])),
    );

    if (!socket) return null;

    run(['forward', `tcp:${port}`, `localabstract:${socket}`]);

    return socket;
};

/**
 * What blocks work with the phone, from `adb devices`: a hint for a person, or null when a phone is
 * connected and allowed debugging.
 */
export const describeDevices = (output: string): string | null => {
    const states = output
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((state): state is string => Boolean(state));

    if (states.includes('device')) return null;
    if (states.length === 0) {
        return 'No phone found: connect it over USB and turn on USB debugging (Settings → Developer options)';
    }
    if (states.includes('unauthorized')) {
        return 'The phone has not allowed debugging: confirm "Allow USB debugging" on its screen';
    }

    return `The phone is "${states[0]}": reconnect the cable`;
};

/** Whether the screen is locked, from `dumpsys window`: a locked WebView does not render. */
export const isKeyguardShowing = (dumpsysOutput: string): boolean =>
    /isKeyguardShowing=true|mDreamingLockscreen=true/.test(dumpsysOutput);
