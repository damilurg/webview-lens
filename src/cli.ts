#!/usr/bin/env node
// webview-lens: the web page inside a native app's Android WebView or iOS WKWebView, from your
// computer. Entry point: parse the command line, then run one command (src/cli/commands).

import { cert, doctor, init } from './cli/commands/setup.ts';
import { dev } from './cli/commands/dev.ts';
import { devtools } from './cli/commands/devtools.ts';
import { keyboard } from './cli/commands/keyboard.ts';
import { vitals } from './cli/commands/vitals.ts';
import { buildCliContext, type CliContext, parseCliArgs } from './cli/context.ts';
import { HELP } from './cli/help.ts';
import { configureLogging, createLogger, loggingFromEnv } from './node/logger.ts';
import { fileURLToPath } from 'node:url';

import { str } from './shared/decode.ts';
import { errorMessage } from './shared/utils.ts';
import { readPackageJson } from './node/fs-utils.ts';
import { terminal } from './cli/output.ts';

/** Startup errors (bad flags, bad config) are user errors: one line, no stack trace. */
const orExit = <T>(fn: () => T): T => {
    try {
        return fn();
    } catch (error) {
        terminal.error(errorMessage(error));
        process.exit(1);
    }
};

const COMMANDS: Readonly<Record<string, (ctx: CliContext) => Promise<void>>> = {
    init,
    dev,
    devtools,
    vitals,
    keyboard,
    cert,
    doctor,
};

const { values, positionals } = orExit(() => parseCliArgs());
const [command, ...args] = positionals;

if (values.version) {
    // The package root: dist/cli.js and src/cli.ts both sit one level below package.json.
    const version = str(readPackageJson(fileURLToPath(new URL('..', import.meta.url)))?.version);

    terminal.line(version ?? 'unknown');
    process.exit(version ? 0 : 1);
}

if (values.help || !command) {
    terminal.line(HELP);
    process.exit(values.help ? 0 : 1);
}

if (typeof WebSocket === 'undefined') {
    terminal.error('webview-lens needs Node.js 22.4 or newer (global WebSocket)');
    process.exit(1);
}

const envLogging = loggingFromEnv();
const logFile = values['log-file'] ?? envLogging.file;

configureLogging({
    verbose: values.verbose || Boolean(envLogging.verbose),
    ...(logFile ? { file: logFile } : {}),
});
createLogger('cli').debug(`command: ${command}`, { args, node: process.version });

const run = COMMANDS[command];

if (!run) {
    terminal.error(`Unknown command: ${command}\n`);
    terminal.line(HELP);
    process.exit(1);
}

const ctx = orExit(() => buildCliContext(command, args, values));

try {
    await run(ctx);
} catch (error) {
    terminal.error(errorMessage(error));
    process.exit(1);
}
