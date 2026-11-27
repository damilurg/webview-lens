// `webview-lens keyboard`: live keyboard and viewport numbers from the page in the app's WebView.

import type { InspectableTarget } from '../../node/drivers/types.ts';
import { waitForVisibleTarget } from '../../node/drivers/visible-target.ts';
import { type KeyboardWatchEnd, watchKeyboard } from '../../node/keyboard-probe.ts';
import { errorMessage, isHttpUrl, sleep } from '../../shared/utils.ts';
import type { CliContext } from '../context.ts';
import { ensureIosProxy, logAdbPath } from '../runtime.ts';
import { terminal } from '../output.ts';

const END_MESSAGES: Readonly<Record<KeyboardWatchEnd, string>> = {
    closed: 'The page closed, waiting for it again…',
    unresponsive: 'The page stopped answering (a WebView left behind?), looking again…',
    hidden: 'This WebView went behind another screen, switching to the visible one…',
    aborted: 'Stopped.',
};

export const keyboard = async (ctx: CliContext): Promise<void> => {
    const driver = await ctx.selectDriver();
    const port = ctx.portFor(driver.platform);

    if (driver.platform === 'android') logAdbPath();
    if (driver.platform === 'ios') await ensureIosProxy();

    const targetOptions = { ...ctx.targetOptions, ...(port !== undefined ? { port } : {}) };
    const matches = (page: InspectableTarget) =>
        page.type === 'page' &&
        isHttpUrl(page.url) &&
        (!ctx.cfg.match || page.url.includes(ctx.cfg.match));

    // Follow the app across restarts and screens, like --logs.
    for (;;) {
        const target = await waitForVisibleTarget(driver, matches, targetOptions);

        try {
            const session = await driver.connectInspector(target);

            terminal.line(
                `Watching the keyboard in ${target.url}. Tap a field on the phone; Ctrl+C exits.`,
            );

            const end = await watchKeyboard({
                session,
                overlay: Boolean(ctx.values.overlay),
                frames: Boolean(ctx.values.frames),
                log: terminal.line,
            });

            session.close();
            terminal.line(END_MESSAGES[end]);
            await sleep(1000);
        } catch (error) {
            terminal.error(errorMessage(error));
            await sleep(2000);
        }
    }
};
