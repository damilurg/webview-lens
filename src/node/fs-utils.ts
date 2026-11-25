// Shared Node-only filesystem, process-tree and socket helpers used across drivers and CLI tools.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import { isRecord } from '../shared/utils.ts';

/** True when `file` exists and is a regular file. Never throws. */
export const isFile = (file: string): boolean => {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
};

/** Immediate child directory paths inside `dir`, or `[]` when unreadable. */
export const listDirs = (dir: string): string[] => {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(dir, entry.name));
    } catch {
        return [];
    }
};

/**
 * Searches `dir` for a file at relative path `segments` (e.g. `['platform-tools', 'adb']`),
 * descending up to `maxDepth` subdirectories.
 */
export const findFileInDirs = (
    dir: string,
    segments: readonly string[],
    maxDepth: number,
): string | undefined => {
    const direct = path.join(dir, ...segments);

    if (isFile(direct)) return direct;
    if (maxDepth <= 0) return undefined;

    for (const child of listDirs(dir)) {
        const found = findFileInDirs(child, segments, maxDepth - 1);

        if (found) return found;
    }

    return undefined;
};

/** Reads and parses `package.json` in `cwd` as a plain object, or returns undefined. */
export const readPackageJson = (cwd: string): Record<string, unknown> | undefined => {
    try {
        const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
        const parsed: unknown = JSON.parse(raw);

        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

export interface KillableProcess {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    kill(signal?: NodeJS.Signals | number): boolean;
}

/** Terminates a spawned process (and its full child tree on Windows). */
export const killProcessTree = (
    child: KillableProcess,
    platform: string = process.platform,
): void => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

        return;
    }
    child.kill('SIGTERM');
};

/**
 * Connects to a TCP target (or a TLS one when `secure` is given), invokes `onConnect` once open,
 * and pipes both sockets with shared error teardown.
 */
export const connectAndPipe = (
    port: number,
    host: string,
    clientSocket: net.Socket,
    onConnect: (upstream: net.Socket) => void,
    secure?: tls.ConnectionOptions,
): net.Socket => {
    const ready = () => {
        onConnect(upstream);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
    };
    const upstream: net.Socket = secure
        ? tls.connect({ ...secure, port, host }, ready)
        : net.connect(port, host, ready);
    const cleanup = () => {
        upstream.destroy();
        clientSocket.destroy();
    };

    upstream.on('error', cleanup);
    clientSocket.on('error', cleanup);

    return upstream;
};
