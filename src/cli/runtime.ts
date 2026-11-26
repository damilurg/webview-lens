// What the long-running commands share: cleanup on exit, the "wait for a page, stream its logs,
// wait again" loop, and the helpers around adb and ios_webkit_debug_proxy.

import { resolveAdb } from '../node/adb.ts';
import type { ProjectConfig } from '../node/config.ts';
import { ensureIwdp } from '../node/drivers/ios/iwdp.ts';
import { fromGitBashPath } from '../node/paths.ts';
import { errorMessage, sleep } from '../shared/utils.ts';
import { terminal } from './output.ts';

/** Runs `cleanup` once on exit, Ctrl+C or SIGTERM. */
export const registerCleanup = (cleanup: () => void): void => {
    let cleaned = false;
    const runOnce = () => {
        if (cleaned) return;
        cleaned = true;
        cleanup();
    };

    process.on('exit', runOnce);
    process.on('SIGINT', () => {
        runOnce();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        runOnce();
        process.exit(0);
    });
};

/** Keeps a command alive until Ctrl+C. */
export const forever = (): Promise<never> => new Promise<never>(() => undefined);

/** --remote-base, --local-base and --bypass as override options (Git Bash paths undone). */
export const basePathOptions = (cfg: ProjectConfig) => ({
    ...(cfg.remoteBase ? { remoteBase: fromGitBashPath(cfg.remoteBase) } : {}),
    ...(cfg.localBase ? { localBase: fromGitBashPath(cfg.localBase) } : {}),
    ...(cfg.bypass ? { bypassPrefixes: cfg.bypass.map(fromGitBashPath) } : {}),
});

export interface TelemetryLoopOptions<T extends { url: string; title?: string }> {
    waitTarget: () => Promise<T>;
    attach: (target: T) => Promise<{ closed: Promise<void>; detach: () => void }>;
    streamLogs: boolean;
    onTarget?: (target: T) => void;
    idleDelayMs?: number;
}

/** Waits for a page, streams its logs until it closes, then waits for the next one. */
export const runTelemetryLoop = async <T extends { url: string; title?: string }>({
    waitTarget,
    attach,
    streamLogs,
    onTarget,
    idleDelayMs = 5000,
}: TelemetryLoopOptions<T>): Promise<never> => {
    for (;;) {
        const target = await waitTarget();

        onTarget?.(target);
        if (!streamLogs) {
            await sleep(idleDelayMs);
            continue;
        }
        try {
            const { closed, detach } = await attach(target);

            terminal.line(`Live logs attached to ${target.url}`);
            await closed;
            detach();
        } catch (error) {
            terminal.error(errorMessage(error));
            await sleep(2000);
        }
    }
};

export const logAdbPath = (): void => {
    try {
        // Driver selection may have resolved adb already, so print the path rather than rely on
        // resolveAdb's first-time callback.
        terminal.line(`adb: ${resolveAdb()}`);
    } catch {
        // waitForPage prints where it looked.
    }
};

/** iOS: every command that talks to the page needs ios_webkit_debug_proxy; start it if it is down. */
export const ensureIosProxy = async (): Promise<void> => {
    const iwdpProc = await ensureIwdp({ log: terminal.line });

    if (iwdpProc) registerCleanup(iwdpProc.stop);
};
