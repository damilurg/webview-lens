// The CLI's terminal output: everything a command shows the person who runs it goes through here.
// Library code never writes to the terminal: it reports what the caller asked to see through
// callbacks (the CLI passes these) and its own diagnostics through createLogger (--verbose).

export interface Output {
    /** A line on stdout: progress, results, the page's console with --logs. */
    line(text?: string): void;
    /** A line on stderr: errors and warnings. */
    error(text: string): void;
    /** A table on stdout (vitals results). */
    table(rows: Record<string, Record<string, string>>): void;
}

export const terminal: Output = {
    line: (text = '') => {
        process.stdout.write(`${text}\n`);
    },
    error: (text) => {
        process.stderr.write(`${text}\n`);
    },
    table: (rows) => {
        console.table(rows);
    },
};

/** The request / error logger shape the dev override and the iOS proxy take. */
export const requestLog = { request: terminal.line, error: terminal.error };

/** Page console, exceptions and failed requests (--logs), as the telemetry options take them. */
export const pageLog = { log: terminal.line, error: terminal.error };
