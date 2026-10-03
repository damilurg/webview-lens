// Waiting for the WebView page on the phone, with one line of what to do while it is not there.

import {
    AdbNotFoundError,
    type AdbRunner,
    describeDevices,
    forwardWebView,
    isKeyguardShowing,
    runAdb,
} from './adb.ts';
import { type DevtoolsPage, listPages, type PagePredicate } from './cdp.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const firstLine = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

export const isAnyPage: PagePredicate = (page) => page.type === 'page';

/** Why there is no page yet: one line with what to do. Also refreshes the port forward. */
export const diagnose = (port: string | number, run: AdbRunner = runAdb): string => {
    try {
        const devicesProblem = describeDevices(run(['devices']));

        if (devicesProblem) return devicesProblem;
    } catch (error) {
        if (!(error instanceof AdbNotFoundError))
            return `adb does not respond: ${firstLine(error)}`;

        return [
            'adb not found. Looked in:',
            ...error.checked.map((place) => `    ${place}`),
            '  Install Android platform-tools (unpacking the archive into Downloads is enough) or set ADB=/path/to/adb',
        ].join('\n');
    }

    if (isKeyguardShowing(run(['shell', 'dumpsys', 'window']))) {
        return 'The phone screen is locked: unlock it, a locked WebView does not render';
    }

    const socket = forwardWebView(port, run);

    return socket
        ? `Port ${port} → ${socket}. Waiting for the page: open the WebView screen in the app`
        : 'No debuggable WebView: open the WebView screen in the app (its build must call WebView.setWebContentsDebuggingEnabled(true))';
};

export interface WaitForPageOptions {
    log?: (line: string) => void;
    intervalMs?: number;
    run?: AdbRunner;
    signal?: AbortSignal;
}

/**
 * The WebView page matching predicate. Until it shows up, every interval re-forwards the port to the
 * current socket, prints what blocks it (phone, adb, screen) and waits, so a caller survives app restarts.
 */
export const waitForPage = async (
    port: string | number,
    predicate: PagePredicate = isAnyPage,
    { log = console.log, intervalMs = 2000, run = runAdb, signal }: WaitForPageOptions = {},
): Promise<DevtoolsPage> => {
    let lastHint = '';

    // The app on screen first: the port may still point at another app's WebView, whose page
    // would be found before the right one.
    try {
        forwardWebView(port, run);
    } catch {
        // adb unavailable: diagnose below says so.
    }

    for (;;) {
        signal?.throwIfAborted();

        const page = (await listPages(port))?.find(predicate);

        if (page) return page;

        let hint: string;

        try {
            hint = diagnose(port, run);
        } catch (error) {
            hint = `adb: ${firstLine(error)}`;
        }

        if (hint !== lastHint) log(`… ${hint}`);
        lastHint = hint;
        await sleep(intervalMs);
    }
};
