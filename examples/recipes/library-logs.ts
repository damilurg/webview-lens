// What webview-lens itself does (adb calls, forwards, sockets, proxy decisions) inside your own app or
// test runner: send its log entries to your logger. The CLI does the same with --verbose / --log-file.

import { configureLogging, type LogEntry } from '../../src/node/index.ts';

/** Any logger with level methods: console, pino, winston… */
interface AppLogger {
    debug(message: string, data?: object): void;
    warn(message: string, data?: object): void;
    error(message: string, data?: object): void;
}

export const forwardLibraryLogs = (logger: AppLogger) =>
    configureLogging({
        file: '.webview-lens/run.jsonl', // also keep a JSON Lines file for bug reports
        sinks: [
            {
                level: 'debug',
                sink: (entry: LogEntry) => {
                    const method = entry.level === 'info' ? 'debug' : entry.level;

                    logger[method](`[webview-lens:${entry.scope}] ${entry.message}`, entry.data);
                },
            },
        ],
    }); // returns a function that turns it off again
