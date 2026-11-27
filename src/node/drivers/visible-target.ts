// Several WebViews can match (an app keeps earlier screens alive, each with its own WebView). A hidden
// one is a trap: on iOS its JavaScript is suspended, so the DOM still answers but evaluate never does
// (DevTools showed Elements and an empty Console on the test iPhone). Pick the one on screen.

import { str } from '../../shared/decode.ts';
import { withTimeout } from '../../shared/utils.ts';
import type {
    DeviceDriver,
    DriverTargetOptions,
    InspectableTarget,
    InspectorSession,
    TargetPredicate,
} from './types.ts';

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

/** The matching target on screen; with one match, that one (no probing); `undefined` with none. */
export const findVisibleTarget = async (
    driver: Pick<DeviceDriver, 'listTargets' | 'connectInspector'>,
    predicate: TargetPredicate,
    options?: DriverTargetOptions,
): Promise<InspectableTarget | undefined> => {
    const candidates = ((await driver.listTargets(options)) ?? []).filter(predicate);

    if (candidates.length <= 1) return candidates[0];

    return (await pickVisibleTarget(driver, candidates)) ?? candidates[0];
};

/** Waits for a matching target like `driver.waitForTarget`, then prefers the one on screen. */
export const waitForVisibleTarget = async (
    driver: Pick<DeviceDriver, 'waitForTarget' | 'listTargets' | 'connectInspector'>,
    predicate: TargetPredicate,
    options?: DriverTargetOptions,
): Promise<InspectableTarget> => {
    const first = await driver.waitForTarget(predicate, options);

    return (await findVisibleTarget(driver, predicate, options)) ?? first;
};
