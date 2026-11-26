// Waiting for the WebView page on the phone, with one line of what to do while it is not there.

import { errorMessage, sleep } from '../shared/utils.ts';
import {
    AdbNotFoundError,
    type AdbRunner,
    createAdbRunner,
    describeDevices,
    forwardWebView,
    isKeyguardShowing,
    runAdb,
} from './adb.ts';
import {
    type DevtoolsPage,
    isPageOnScreen,
    listPages,
    type PagePredicate,
    pickPage,
} from './cdp.ts';

const firstLine = (error: unknown) => errorMessage(error).split('\n')[0] ?? '';

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
    listPages?: typeof listPages;
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
        listPages: listPagesFn = listPages,
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

        const page = pickPage(await listPagesFn(port), predicate);

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

export interface WatchScreenOptions {
    intervalMs?: number;
    listPages?: typeof listPages;
    signal?: AbortSignal;
}

/**
 * Resolves with the new page once another WebView matching `predicate` is the one on screen while
 * `currentId` is not: apps recreate their WebView (rotation, a new screen) and leave the old one
 * alive but hidden. Never resolves while `currentId` stays on screen (or no page reports it).
 */
export const waitForOtherPageOnScreen = async (
    port: string | number,
    currentId: string,
    predicate: PagePredicate,
    { intervalMs = 2000, listPages: listPagesFn = listPages, signal }: WatchScreenOptions = {},
): Promise<DevtoolsPage> => {
    for (;;) {
        signal?.throwIfAborted();

        const pages = (await listPagesFn(port)) ?? [];
        const current = pages.find((page) => page.id === currentId);
        const onScreen = pages.filter(predicate).find(isPageOnScreen);

        if (onScreen && onScreen.id !== currentId && current && !isPageOnScreen(current)) {
            return onScreen;
        }
        await sleep(intervalMs);
    }
};
