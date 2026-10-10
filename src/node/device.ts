// Waiting for the WebView page on the phone, with one line of what to do while it is not there.

import {
    AdbNotFoundError,
    type AdbRunner,
    createAdbRunner,
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

export interface DiagnoseOptions {
    /** Target a specific device serial when multiple phones are connected. */
    serial?: string;
    /** Pin WebView socket selection to a specific Android package name. */
    app?: string;
}

/** Why there is no page yet: one line with what to do. Also refreshes the port forward. */
export const diagnose = (
    port: string | number,
    run: AdbRunner = runAdb,
    options: DiagnoseOptions = {},
): string => {
    const deviceRun = createAdbRunner(options.serial, run);

    try {
        const devicesProblem = describeDevices(run(['devices']), options.serial);

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

    if (isKeyguardShowing(deviceRun(['shell', 'dumpsys', 'window']))) {
        return 'The phone screen is locked: unlock it, a locked WebView does not render';
    }

    const socket = forwardWebView(port, deviceRun, options.app ? { app: options.app } : {});

    if (socket) {
        return `Port ${port} → ${socket}. Waiting for the page: open the WebView screen in the app`;
    }
    if (options.app) {
        return `No debuggable WebView for app "${options.app}": open its WebView screen (must call WebView.setWebContentsDebuggingEnabled(true))`;
    }

    return 'No debuggable WebView: open the WebView screen in the app (its build must call WebView.setWebContentsDebuggingEnabled(true))';
};

export interface WaitForPageOptions extends DiagnoseOptions {
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
    {
        log = console.log,
        intervalMs = 2000,
        run = runAdb,
        serial,
        app,
        signal,
    }: WaitForPageOptions = {},
): Promise<DevtoolsPage> => {
    let lastHint = '';
    const deviceRun = createAdbRunner(serial, run);
    const targetOptions: DiagnoseOptions = {
        ...(serial ? { serial } : {}),
        ...(app ? { app } : {}),
    };

    // The app on screen first: the port may still point at another app's WebView, whose page
    // would be found before the right one.
    try {
        forwardWebView(port, deviceRun, app ? { app } : {});
    } catch {
        // adb unavailable: diagnose below says so.
    }

    for (;;) {
        signal?.throwIfAborted();

        const page = (await listPages(port))?.find(predicate);

        if (page) return page;

        let hint: string;

        try {
            hint = diagnose(port, run, targetOptions);
        } catch (error) {
            hint = `adb: ${firstLine(error)}`;
        }

        if (hint !== lastHint) log(`… ${hint}`);
        lastHint = hint;
        await sleep(intervalMs);
    }
};
