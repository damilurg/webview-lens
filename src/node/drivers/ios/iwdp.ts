// Discovery and HTTP queries for ios_webkit_debug_proxy (IWDP) on macOS, Windows and Linux.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FindIwdpOptions {
    env?: Record<string, string | undefined>;
    home?: string;
    platform?: string;
}

export interface FindIwdpResult {
    iwdp: string | undefined;
    checked: string[];
}

export interface IwdpDeviceEntry {
    deviceId: string;
    deviceName?: string;
    url: string;
}

export interface IwdpPage {
    id?: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
    devtoolsFrontendUrl?: string;
    appId?: string;
}

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

const findInDir = (dir: string, binFile: string, depth: number): string | undefined => {
    const direct = path.join(dir, binFile);

    if (isFile(direct)) return direct;
    if (depth === 0) return undefined;

    for (const child of listDirs(dir)) {
        const found = findInDir(child, binFile, depth - 1);

        if (found) return found;
    }

    return undefined;
};

/**
 * Finds `ios_webkit_debug_proxy` without setup: `IWDP` / `IOS_WEBKIT_DEBUG_PROXY`, `PATH`,
 * standard Homebrew/Scoop locations, or an unpacked folder in Downloads.
 */
export const findIwdp = ({
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
}: FindIwdpOptions = {}): FindIwdpResult => {
    const binFile = platform === 'win32' ? 'ios_webkit_debug_proxy.exe' : 'ios_webkit_debug_proxy';
    const checked: string[] = [];
    const envPath = env.IWDP ?? env.IOS_WEBKIT_DEBUG_PROXY;

    if (envPath) {
        checked.push(`IWDP=${envPath}`);
        if (isFile(envPath)) return { iwdp: envPath, checked };
    }

    const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
    const extraDirs =
        platform === 'win32'
            ? [path.join(home, 'scoop', 'shims')]
            : ['/opt/homebrew/bin', '/usr/local/bin'];

    for (const file of [...pathDirs, ...extraDirs].map((dir) => path.join(dir, binFile))) {
        if (isFile(file)) return { iwdp: file, checked };
    }
    checked.push('PATH, Homebrew/Scoop');

    const downloads = path.join(home, 'Downloads');
    const fromDownloads = findInDir(downloads, binFile, 2);

    checked.push(`${downloads} (${binFile})`);

    return { iwdp: fromDownloads, checked };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

/** Reads connected iOS device port mappings from IWDP's control port (default 9221). */
export const listIwdpDevices = async (
    controlPort: number | string = 9221,
    fetchImpl: typeof fetch = fetch,
): Promise<IwdpDeviceEntry[] | null> => {
    try {
        const res = await fetchImpl(`http://localhost:${controlPort}/json`);

        if (!res.ok) return null;

        const data: unknown = await res.json();

        if (!Array.isArray(data)) return null;

        return data.flatMap((entry): IwdpDeviceEntry[] => {
            if (
                !isRecord(entry) ||
                typeof entry.deviceId !== 'string' ||
                typeof entry.url !== 'string'
            ) {
                return [];
            }

            return [
                {
                    deviceId: entry.deviceId,
                    url: entry.url,
                    ...(typeof entry.deviceName === 'string'
                        ? { deviceName: entry.deviceName }
                        : {}),
                },
            ];
        });
    } catch {
        return null;
    }
};

/** Reads inspectable WKWebView / Safari pages exposed on a device's IWDP port (default 9222). */
export const listIwdpPages = async (
    devicePort: number | string = 9222,
    fetchImpl: typeof fetch = fetch,
): Promise<IwdpPage[] | null> => {
    try {
        const res = await fetchImpl(`http://localhost:${devicePort}/json`);

        if (!res.ok) return null;

        const data: unknown = await res.json();

        if (!Array.isArray(data)) return null;

        return data.flatMap((entry): IwdpPage[] => {
            if (!isRecord(entry) || typeof entry.url !== 'string') return [];

            return [
                {
                    ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
                    title: typeof entry.title === 'string' ? entry.title : '',
                    url: entry.url,
                    ...(typeof entry.webSocketDebuggerUrl === 'string'
                        ? { webSocketDebuggerUrl: entry.webSocketDebuggerUrl }
                        : {}),
                    ...(typeof entry.devtoolsFrontendUrl === 'string'
                        ? { devtoolsFrontendUrl: entry.devtoolsFrontendUrl }
                        : {}),
                    ...(typeof entry.appId === 'string' ? { appId: entry.appId } : {}),
                },
            ];
        });
    } catch {
        return null;
    }
};

export interface StartedIwdp {
    readonly exitCode: number | null;
    stop(): void;
}

export interface EnsureIwdpOptions {
    controlPort?: number | string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    findIwdp?: typeof findIwdp;
    listIwdpDevices?: typeof listIwdpDevices;
    spawnIwdp?: (bin: string, args: string[]) => StartedIwdp;
    log?: (line: string) => void;
}

const defaultSpawnIwdp = (bin: string, args: string[]): StartedIwdp => {
    const child = spawn(bin, args, { stdio: 'ignore' });

    return {
        get exitCode() {
            return child.exitCode;
        },
        stop: () => {
            if (child.exitCode !== null || child.pid === undefined) return;
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

                return;
            }
            child.kill('SIGTERM');
        },
    };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ensures `ios_webkit_debug_proxy` is listening on `controlPort`. If it is down and the binary is
 * found, starts it with `-f` and returns a handle to stop it on exit; returns undefined when it
 * was already running or when the binary is not installed.
 */
export const ensureIwdp = async ({
    controlPort = 9221,
    pollIntervalMs = 250,
    timeoutMs = 5000,
    findIwdp: findFn = findIwdp,
    listIwdpDevices: listFn = listIwdpDevices,
    spawnIwdp = defaultSpawnIwdp,
    log = console.log,
}: EnsureIwdpOptions = {}): Promise<StartedIwdp | undefined> => {
    if ((await listFn(controlPort)) !== null) return undefined;

    const { iwdp } = findFn();

    if (!iwdp) return undefined;

    log(`Starting ios_webkit_debug_proxy: ${iwdp} -f`);
    const proc = spawnIwdp(iwdp, ['-f']);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if ((await listFn(controlPort)) !== null) return proc;
        if (proc.exitCode !== null) return undefined;
        await sleep(pollIntervalMs);
    }

    return proc;
};
