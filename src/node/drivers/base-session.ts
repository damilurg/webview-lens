// Shared protocol-backed InspectorSession composition for Android (CDP) and iOS (WIP↔CDP bridge).

import { waitWithTimeout } from '../../shared/utils.ts';
import type { Cdp } from '../cdp.ts';
import { attachTelemetry, type TelemetryOptions } from '../telemetry.ts';
import type {
    InspectorCapabilities,
    InspectorSession,
    NavigateOptions,
    Platform,
} from './types.ts';

export interface ProtocolSessionOptions {
    platform: Platform;
    capabilities: InspectorCapabilities;
    /** Protocol-specific domain activation executed when live telemetry attaches. */
    enableTelemetry: () => Promise<void>;
}

/**
 * Builds the shared core of `InspectorSession` on top of any CDP-shaped transport
 * (raw Chromium CDP on Android or the WIP↔CDP bridge on iOS).
 */
export const createProtocolInspectorSession = (
    transport: Cdp,
    { platform, capabilities, enableTelemetry }: ProtocolSessionOptions,
): InspectorSession => ({
    platform,
    capabilities,
    async evaluate<T = unknown>(expression: string): Promise<T> {
        const { result } = await transport.send<{ result?: { value?: T } }>('Runtime.evaluate', {
            expression,
            returnByValue: true,
        });

        return result?.value as T;
    },
    async addInitScript(source: string): Promise<void> {
        await transport.send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async navigate(
        url: string,
        { waitForLoad = false, timeoutMs = 30_000 }: NavigateOptions = {},
    ): Promise<void> {
        if (!waitForLoad) {
            await transport.send('Page.navigate', { url });

            return;
        }

        const loaded = transport.once('Page.loadEventFired');

        await transport.send('Page.navigate', { url });
        await waitWithTimeout(loaded, timeoutMs);
    },
    async reload({ ignoreCache = false }: { ignoreCache?: boolean } = {}): Promise<void> {
        await transport.send('Page.reload', { ignoreCache });
    },
    async setCacheDisabled(disabled: boolean): Promise<void> {
        await transport.send('Network.setCacheDisabled', { cacheDisabled: disabled });
    },
    async attachTelemetry(options?: TelemetryOptions): Promise<() => void> {
        const detach = attachTelemetry(transport, options);

        await enableTelemetry();

        return detach;
    },
    close: () => transport.close(),
    closed: transport.closed,
});
