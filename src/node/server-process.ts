// The local server for `webview-lens dev`: the one already running, or one started from a command.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isServerUp = (url: string): Promise<boolean> =>
    fetch(url, { method: 'HEAD', redirect: 'manual' }).then(
        () => true,
        () => false,
    );

export interface StartedServer {
    process: ChildProcess;
    stop(): void;
}

/** Runs a shell command, prefixing its output; `stop` kills the whole process tree. */
export const spawnServer = (
    command: string,
    {
        prefix = '[server]',
        log = console.log,
    }: { prefix?: string; log?: (line: string) => void } = {},
): StartedServer => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

    for (const stream of [child.stdout, child.stderr]) {
        readline.createInterface({ input: stream }).on('line', (line) => log(`${prefix} ${line}`));
    }
    child.on('exit', (code) => log(`${prefix} stopped (code ${code})`));

    return {
        process: child,
        stop: () => {
            if (child.exitCode !== null || child.pid === undefined) return;
            // shell: true makes a cmd → yarn → node tree on Windows; kill would stop only cmd.
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

                return;
            }
            child.kill('SIGTERM');
        },
    };
};

export interface EnsureServerOptions {
    /** Command that starts the server when it does not answer, such as `npm run dev -- -p 3000`. */
    command?: string;
    log?: (line: string) => void;
}

/**
 * Waits until `url` answers. Starts `command` first when the server is down and the URL is local.
 * Returns the started server (to stop it on exit) or undefined when it was already running.
 */
export const ensureServer = async (
    url: string,
    { command, log = console.log }: EnsureServerOptions = {},
): Promise<StartedServer | undefined> => {
    if (await isServerUp(url)) return undefined;

    const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
    let server: StartedServer | undefined;

    if (command && isLocalhost) {
        log(`Starting the local server: ${command}`);
        server = spawnServer(command, { log });
    }
    if (!server) {
        log(`… Local server ${url} does not respond: start it (or pass --cmd), waiting`);
    }

    while (!(await isServerUp(url))) {
        if (server && server.process.exitCode !== null) {
            throw new Error('The local server did not start: see the [server] output above');
        }
        await sleep(1000);
    }
    log(`Local server ${url} responds`);

    return server;
};
