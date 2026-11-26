// What webview-lens itself is doing (adb calls, port forwards, CDP sockets, WebKit targets, proxy
// decisions), for when something does not work. Off by default; the page's own console belongs in
// DevTools (`devtools`) or `--logs`.
//
//   --verbose | WEBVIEW_LENS_DEBUG=1           debug lines on stderr
//   --log-file <path> | WEBVIEW_LENS_LOG_FILE  JSON Lines (one entry per line) appended to a file
//
// The configuration is the one module-level state of the library, like the `debug` package: every
// module asks `createLogger(scope)`. The environment variables work in your own scripts too; the
// entry point (the CLI, or your code via configureLogging) can replace them.

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    time: string;
    level: LogLevel;
    scope: string;
    message: string;
    data?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

const write = (level: LogLevel, scope: string, message: string, data?: Record<string, unknown>) => {
    if (sinks.length === 0) return;

    const entry: LogEntry = {
        time: new Date().toISOString(),
        level,
        scope,
        message,
        ...(data ? { data } : {}),
    };

    for (const { sink, minRank } of sinks) {
        if (RANK[level] < minRank) continue;
        try {
            sink(entry);
        } catch {
            // A broken sink (full disk, closed stream) must never break the tool.
        }
    }
};

/** A logger for one area of the library; cheap to create, silent until logging is configured. */
export const createLogger = (scope: string): Logger => ({
    debug: (message, data) => write('debug', scope, message, data),
    info: (message, data) => write('info', scope, message, data),
    warn: (message, data) => write('warn', scope, message, data),
    error: (message, data) => write('error', scope, message, data),
});

/** One human-readable stderr line: `12:01:02.345 debug [adb] message {"key":1}`. */
export const formatLogLine = (entry: LogEntry): string => {
    const time = entry.time.slice(11, 23);
    const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';

    return `${time} ${entry.level.padEnd(5)} [webview-lens:${entry.scope}] ${entry.message}${data}`;
};

export const stderrSink: LogSink = (entry) => {
    process.stderr.write(`${formatLogLine(entry)}\n`);
};

/** Appends JSON Lines to `file` (its folder is created). */
export const fileSink = (file: string): LogSink => {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

    return (entry) => fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

export interface LoggingOptions {
    /** Debug lines on stderr. */
    verbose?: boolean;
    /** JSON Lines file with every entry, debug included. */
    file?: string;
    /** Extra sinks (tests, an app's own logger). */
    sinks?: readonly { sink: LogSink; level?: LogLevel }[];
}

/** Logging options from the environment (`WEBVIEW_LENS_DEBUG`, `WEBVIEW_LENS_LOG_FILE`). */
export const loggingFromEnv = (
    env: Record<string, string | undefined> = process.env,
): LoggingOptions => ({
    verbose: ['1', 'true', 'yes'].includes((env.WEBVIEW_LENS_DEBUG ?? '').toLowerCase()),
    ...(env.WEBVIEW_LENS_LOG_FILE ? { file: env.WEBVIEW_LENS_LOG_FILE } : {}),
});

type SinkEntry = { sink: LogSink; minRank: number };

const toSinks = ({ verbose = false, file, sinks: extra = [] }: LoggingOptions): SinkEntry[] => [
    ...(verbose ? [{ sink: stderrSink, minRank: RANK.debug }] : []),
    ...(file ? [{ sink: fileSink(file), minRank: RANK.debug }] : []),
    ...extra.map(({ sink, level = 'debug' }) => ({ sink, minRank: RANK[level] })),
];

// Until someone configures it, the environment decides: WEBVIEW_LENS_DEBUG=1 shows the library's
// lines in any script that uses it, not only in the CLI.
let sinks: SinkEntry[] = toSinks(loggingFromEnv());

/** Sets where entries go, replacing any earlier configuration (the environment's too). Returns a reset function. */
export const configureLogging = (options: LoggingOptions) => {
    sinks = toSinks(options);

    return () => {
        sinks = [];
    };
};
