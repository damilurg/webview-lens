// WebKit Inspector target multiplexing (iOS 12.2+). A page socket from ios_webkit_debug_proxy no
// longer accepts domain commands directly ("'Runtime' domain was not found"): WebKit announces its
// targets with `Target.targetCreated`, every command goes inside `Target.sendMessageToTarget`, and
// replies and events come back inside `Target.dispatchMessageFromTarget`. This router hides that,
// so the CDP translator and the Chrome DevTools UI keep speaking plain protocol messages.

import { isRecord } from '../../../shared/utils.ts';
import { type Cdp, connectCdp } from '../../cdp.ts';

export interface WebKitTargetRouterOptions {
    /** Writes a raw frame to the WebKit socket. */
    sendUpstream: (raw: string) => void;
    /** Receives an unwrapped protocol message (reply or event) from the inspected page. */
    deliver: (raw: string) => void;
    /**
     * With no `Target.targetCreated` within this time the page speaks the pre-12.2 protocol:
     * queued commands are then sent as they are. Default 1500 ms.
     */
    legacyAfterMs?: number;
}

export interface WebKitTargetRouter {
    /** Feeds a raw frame received from the WebKit socket. */
    onUpstream(raw: string): void;
    /** Sends a plain protocol command to the page (wrapped, queued or direct). */
    send(raw: string): void;
    /** The target commands go to, once known. */
    readonly targetId: string | undefined;
    dispose(): void;
}

/** Ids of the wrapper commands; far above the ids of the clients they carry. */
const WRAPPER_ID_BASE = 2_000_000_000;

const parse = (raw: string): Record<string, unknown> | undefined => {
    try {
        const value: unknown = JSON.parse(raw);

        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
};

export const createWebKitTargetRouter = ({
    sendUpstream,
    deliver,
    legacyAfterMs = 1500,
}: WebKitTargetRouterOptions): WebKitTargetRouter => {
    let targetId: string | undefined;
    let targetIsPage = false;
    let legacy = false;
    let nextWrapperId = WRAPPER_ID_BASE;
    const wrapperIds = new Set<number>();
    const queue: string[] = [];

    const sendToTarget = (raw: string) => {
        if (legacy) {
            sendUpstream(raw);

            return;
        }
        if (!targetId) {
            queue.push(raw);

            return;
        }
        nextWrapperId += 1;
        wrapperIds.add(nextWrapperId);
        sendUpstream(
            JSON.stringify({
                id: nextWrapperId,
                method: 'Target.sendMessageToTarget',
                params: { targetId, message: raw },
            }),
        );
    };

    const flush = () => {
        for (const raw of queue.splice(0)) sendToTarget(raw);
    };

    const legacyTimer = setTimeout(() => {
        if (targetId) return;
        legacy = true;
        flush();
    }, legacyAfterMs);

    legacyTimer.unref?.();

    const onTargetCreated = (params: unknown) => {
        const info =
            isRecord(params) && isRecord(params.targetInfo) ? params.targetInfo : undefined;
        const id = typeof info?.targetId === 'string' ? info.targetId : undefined;

        if (!id) return;
        // Prefer the page target; a frame target only stands in until one is announced.
        const isPage = info?.type === 'page';

        if (targetId && (targetIsPage || !isPage)) return;
        targetId = id;
        targetIsPage = isPage;
        clearTimeout(legacyTimer);
        flush();
    };

    return {
        get targetId() {
            return targetId;
        },
        onUpstream(raw: string) {
            const message = parse(raw);

            if (!message) return;

            const { method, params, id } = message;

            if (typeof id === 'number' && wrapperIds.delete(id)) return;
            if (method === 'Target.targetCreated') return void onTargetCreated(params);
            if (method === 'Target.didCommitProvisionalTarget' && isRecord(params)) {
                if (params.oldTargetId === targetId && typeof params.newTargetId === 'string') {
                    targetId = params.newTargetId;
                }

                return;
            }
            if (method === 'Target.targetDestroyed' && isRecord(params)) {
                if (params.targetId === targetId) {
                    targetId = undefined;
                    targetIsPage = false;
                }

                return;
            }
            if (method === 'Target.dispatchMessageFromTarget' && isRecord(params)) {
                if (typeof params.message === 'string') deliver(params.message);

                return;
            }
            deliver(raw);
        },
        send: sendToTarget,
        dispose() {
            clearTimeout(legacyTimer);
            queue.length = 0;
        },
    };
};

/** A WebKit Inspector page socket (iOS) as a CDP-shaped transport, with target routing. */
export const connectWebKitInspector = (webSocketDebuggerUrl: string): Promise<Cdp> =>
    connectCdp(webSocketDebuggerUrl, { adapter: (io) => createWebKitTargetRouter(io) });
