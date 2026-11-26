// `webview-lens keyboard`: live keyboard and viewport numbers from the page in the app's WebView.

import type { InspectableTarget, InspectorSession } from '../../node/drivers/types.ts';
import { type KeyboardWatchEnd, watchKeyboard } from '../../node/keyboard-probe.ts';
import { str } from '../../shared/decode.ts';
import { errorMessage, isHttpUrl, sleep, withTimeout } from '../../shared/utils.ts';
import type { CliContext } from '../context.ts';
import { ensureIosProxy, logAdbPath } from '../runtime.ts';
import { terminal } from '../output.ts';

const END_MESSAGES: Readonly<Record<KeyboardWatchEnd, string>> = {
    closed: 'The page closed, waiting for it again…',
    unresponsive: 'The page stopped answering (a WebView left behind?), looking again…',
    hidden: 'This WebView went behind another screen, switching to the visible one…',
    aborted: 'Stopped.',
};

/**
 * Among several matching WebViews (an app keeps earlier screens alive), the one on screen. iOS lets
 * one inspector attach to a page at a time, so each is asked briefly and released.
 */
export const pickVisibleTarget = async (
    driver: {
        connectInspector(
            target: InspectableTarget,
        ): Promise<Pick<InspectorSession, 'evaluate' | 'close'>>;
    },
    candidates: readonly InspectableTarget[],
    timeoutMs = 2000,
): Promise<InspectableTarget | undefined> => {
    for (const candidate of candidates) {
        try {
            const connecting = driver.connectInspector(candidate);
            const connected = await withTimeout(connecting, timeoutMs);

            // A stale iOS target may never answer: release it if it connects later after all.
            if (connected.timedOut) {
                void connecting.then((late) => late.close()).catch(() => undefined);
                continue;
            }

            const session = connected.value;
            const answer = await withTimeout(
                session.evaluate('document.visibilityState'),
                timeoutMs,
            );

            session.close();
            if (!answer.timedOut && str(answer.value) === 'visible') return candidate;
        } catch {
            // A target that vanished meanwhile is simply not the visible one.
        }
    }

    return undefined;
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
        const first = await driver.waitForTarget(matches, targetOptions);
        const candidates = ((await driver.listTargets(targetOptions)) ?? [first]).filter(matches);
        const target =
            candidates.length > 1
                ? ((await pickVisibleTarget(driver, candidates)) ?? first)
                : first;

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
