// Platform-agnostic contracts for WebView device drivers (Android, iOS) and inspector sessions.

import type { TelemetryOptions } from '../telemetry.ts';

export type Platform = 'android' | 'ios';

export type PlatformSelection = Platform | 'auto';

export const PLATFORM_SELECTIONS: readonly PlatformSelection[] = ['auto', 'android', 'ios'];

export const isPlatformSelection = (value: string): value is PlatformSelection =>
    (PLATFORM_SELECTIONS as readonly string[]).includes(value);

export interface ConnectedDevice {
    id: string;
    platform: Platform;
    state: string;
    name?: string;
}

export interface InspectableTarget {
    id: string;
    platform: Platform;
    type: string;
    url: string;
    title: string;
    debuggerUrl: string;
    frontendUrl?: string;
}

export type TargetPredicate = (target: InspectableTarget) => boolean;

export interface DoctorCheck {
    ok: boolean;
    message: string;
}

export interface DoctorReport {
    platform: Platform;
    checks: DoctorCheck[];
    targets: InspectableTarget[];
}

export interface DriverTargetOptions {
    /** Local forwarded port (Android CDP) or proxy port. */
    port?: string | number;
    /** Device serial (Android) or UDID (iOS). */
    serial?: string;
    /** Package name (Android) or Bundle ID (iOS). */
    app?: string;
    log?: (line: string) => void;
    intervalMs?: number;
    signal?: AbortSignal;
}

export interface InspectorCapabilities {
    readonly lcp: boolean;
    readonly cls: boolean;
    readonly inp: boolean;
    readonly cdpFetchOverride: boolean;
}

export interface NavigateOptions {
    waitForLoad?: boolean;
    timeoutMs?: number;
}

export interface InspectorSession {
    readonly platform: Platform;
    readonly capabilities: InspectorCapabilities;
    evaluate<T = unknown>(expression: string): Promise<T>;
    addInitScript(source: string): Promise<void>;
    navigate(url: string, options?: NavigateOptions): Promise<void>;
    reload(options?: { ignoreCache?: boolean }): Promise<void>;
    setCacheDisabled(disabled: boolean): Promise<void>;
    attachTelemetry?(options?: TelemetryOptions): Promise<() => void>;
    close(): void;
    readonly closed: Promise<void>;
}

export interface DeviceDriver {
    readonly platform: Platform;
    /** Lists connected devices for this platform without throwing if tooling is absent. */
    listDevices(): ConnectedDevice[] | Promise<ConnectedDevice[]>;
    /** True when at least one usable device of this platform is currently connected. */
    isAvailable(): boolean | Promise<boolean>;
    /** Single-line human-readable hint explaining what blocks attaching to a target. */
    diagnose(options?: DriverTargetOptions): Promise<string>;
    /** Structured diagnostics for `webview-lens doctor`. */
    doctor(options?: DriverTargetOptions): Promise<DoctorReport>;
    /** Inspectable WebView targets currently exposed on the device. */
    listTargets(options?: DriverTargetOptions): Promise<InspectableTarget[] | null>;
    /** Waits until a target matching `predicate` appears. */
    waitForTarget(
        predicate: TargetPredicate,
        options?: DriverTargetOptions,
    ): Promise<InspectableTarget>;
    /** Human-readable device/WebView description for lab reports. */
    getDeviceDescription(options?: DriverTargetOptions): Promise<string>;
    /** Opens an active inspector session to the given target. */
    connectInspector(target: InspectableTarget): Promise<InspectorSession>;
}
