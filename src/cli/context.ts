// Command-line flags and webview-lens.config.json, parsed and validated once into a CliContext
// that every command receives. Throws on invalid input; the entry point prints the message.

import { parseArgs } from 'node:util';

import type { PagePredicate } from '../node/cdp.ts';
import {
    type LoadedProjectConfig,
    loadProjectConfig,
    mergeCliConfig,
    type ProjectConfig,
    validateProjectConfig,
} from '../node/config.ts';
import { resolveDriver } from '../node/drivers/registry.ts';
import {
    type DeviceDriver,
    isPlatformSelection,
    PLATFORM_SELECTIONS,
} from '../node/drivers/types.ts';
import { isPresetSelection, PRESET_SELECTIONS } from '../node/presets.ts';
import { isNetworkThrottlePreset, NETWORK_THROTTLE_PRESETS } from '../node/vitals-lab.ts';

export const parseCliArgs = (argv: string[] = process.argv.slice(2)) =>
    parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            config: { type: 'string' },
            force: { type: 'boolean', default: false },
            platform: { type: 'string' },
            port: { type: 'string' },
            serial: { type: 'string' },
            app: { type: 'string' },
            match: { type: 'string' },
            logs: { type: 'boolean' },
            remote: { type: 'string' },
            'remote-base': { type: 'string' },
            'local-base': { type: 'string' },
            preset: { type: 'string' },
            cmd: { type: 'string' },
            ws: { type: 'string', multiple: true },
            'hmr-port': { type: 'string', multiple: true },
            quiet: { type: 'string', multiple: true },
            bypass: { type: 'string', multiple: true },
            sse: { type: 'string' },
            forwarded: { type: 'boolean' },
            'proxy-port': { type: 'string' },
            'link-port': { type: 'string' },
            runs: { type: 'string', default: '3' },
            cold: { type: 'boolean', default: false },
            interact: { type: 'string', default: '0' },
            throttle: { type: 'string' },
            cpu: { type: 'string' },
            budget: { type: 'string' },
            out: { type: 'string', default: 'webview-vitals.md' },
        },
    });

export type CliValues = ReturnType<typeof parseCliArgs>['values'];

export interface CliContext {
    command: string;
    /** Positionals after the command (dev: local URL, vitals: paths). */
    args: string[];
    values: CliValues;
    loadedConfig: LoadedProjectConfig;
    /** Config file merged with flags (flags win), validated. */
    cfg: ProjectConfig;
    /** Android forward port: --port, DEVTOOLS_PORT or 9223. */
    port: string;
    linkPort: string;
    proxyPort: number;
    serial: string | undefined;
    logsEnabled: boolean;
    targetOptions: { serial?: string; app?: string };
    remoteOrigin: string | undefined;
    /** Android page filter: --match, else any page with --remote, else any https page. */
    isTarget: PagePredicate;
    /** The Android forward port, or an explicit --port; iOS takes its ports from the proxy. */
    portFor(platform: string): string | undefined;
    selectDriver(): Promise<DeviceDriver>;
}

const parseHmrPorts = (raw: string[] | undefined): number[] | undefined =>
    raw?.map((p) => {
        const num = Number(p);

        if (!Number.isInteger(num) || num <= 0 || num > 65535) {
            throw new Error(`Invalid --hmr-port "${p}"`);
        }

        return num;
    });

const checkFlags = (values: CliValues): void => {
    if (values.platform !== undefined && !isPlatformSelection(values.platform)) {
        throw new Error(
            `Unknown --platform "${values.platform}". Expected one of: ${PLATFORM_SELECTIONS.join(', ')}`,
        );
    }
    if (values.preset !== undefined && !isPresetSelection(values.preset)) {
        throw new Error(
            `Unknown --preset "${values.preset}". Expected one of: ${PRESET_SELECTIONS.join(', ')}`,
        );
    }
    if (values.sse !== undefined && values.sse !== 'fail' && values.sse !== 'continue') {
        throw new Error(`Unknown --sse "${values.sse}". Expected "fail" or "continue"`);
    }
    if (values.throttle !== undefined && !isNetworkThrottlePreset(values.throttle)) {
        throw new Error(
            `Unknown --throttle "${values.throttle}". Expected one of: ${NETWORK_THROTTLE_PRESETS.join(', ')}`,
        );
    }

    const runs = Number(values.runs);
    const interact = Number(values.interact);

    if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`Invalid --runs "${values.runs}". Expected an integer >= 1`);
    }
    if (!Number.isFinite(interact) || interact < 0) {
        throw new Error(`Invalid --interact "${values.interact}". Expected seconds >= 0`);
    }
};

/** Flags as config keys, only those given: they override webview-lens.config.json. */
const flagsAsConfig = (
    values: CliValues,
    command: string,
    args: string[],
): Partial<ProjectConfig> => {
    const hmrPorts = parseHmrPorts(values['hmr-port']);

    return {
        ...(values.platform !== undefined ? { platform: values.platform } : {}),
        ...(values.preset !== undefined ? { preset: values.preset } : {}),
        ...(args[0] !== undefined && command === 'dev' ? { local: args[0] } : {}),
        ...(values.remote !== undefined ? { remote: values.remote } : {}),
        ...(values['remote-base'] !== undefined ? { remoteBase: values['remote-base'] } : {}),
        ...(values['local-base'] !== undefined ? { localBase: values['local-base'] } : {}),
        ...(values.cmd !== undefined ? { cmd: values.cmd } : {}),
        ...(values.ws !== undefined ? { ws: values.ws } : {}),
        ...(hmrPorts !== undefined ? { hmrPorts } : {}),
        ...(values.quiet !== undefined ? { quiet: values.quiet } : {}),
        ...(values.bypass !== undefined ? { bypass: values.bypass } : {}),
        ...(values.sse !== undefined ? { sse: values.sse } : {}),
        ...(values.forwarded !== undefined ? { forwarded: values.forwarded } : {}),
        ...(values.port !== undefined ? { port: values.port } : {}),
        ...(values['link-port'] !== undefined ? { linkPort: values['link-port'] } : {}),
        ...(values['proxy-port'] !== undefined ? { proxyPort: values['proxy-port'] } : {}),
        ...(values.serial !== undefined ? { serial: values.serial } : {}),
        ...(values.app !== undefined ? { app: values.app } : {}),
        ...(values.match !== undefined ? { match: values.match } : {}),
        ...(values.logs !== undefined ? { logs: values.logs } : {}),
        ...(values.throttle !== undefined ? { throttle: values.throttle } : {}),
        ...(values.cpu !== undefined ? { cpu: Number(values.cpu) } : {}),
        ...(values.budget !== undefined ? { budget: values.budget } : {}),
    } as Partial<ProjectConfig>;
};

const originOf = (remote: string | undefined): string | undefined => {
    if (!remote) return undefined;
    try {
        return new URL(remote).origin;
    } catch {
        throw new Error(`Invalid --remote "${remote}". Expected an absolute URL`);
    }
};

export const buildCliContext = (
    command: string,
    args: string[],
    values: CliValues,
    env: Record<string, string | undefined> = process.env,
): CliContext => {
    const loadedConfig = loadProjectConfig(values.config ? { configPath: values.config } : {});

    checkFlags(values);

    // The merged result goes through the same validation as the config file (ports, cpu, …).
    const cfg = validateProjectConfig(
        mergeCliConfig(loadedConfig.config, flagsAsConfig(values, command, args)),
    );
    const explicitPort = cfg.port ?? env.DEVTOOLS_PORT;
    const port = String(explicitPort ?? '9223');
    const serial = cfg.serial ?? env.ANDROID_SERIAL;
    const remoteOrigin = originOf(cfg.remote);

    return {
        command,
        args,
        values,
        loadedConfig,
        cfg,
        port,
        linkPort: String(cfg.linkPort ?? env.DEVTOOLS_LINK_PORT ?? '3300'),
        proxyPort: Number(cfg.proxyPort ?? 8888),
        serial,
        logsEnabled: Boolean(cfg.logs),
        targetOptions: {
            ...(serial ? { serial } : {}),
            ...(cfg.app ? { app: cfg.app } : {}),
        },
        remoteOrigin,
        isTarget: (page) => {
            if (page.type !== 'page') return false;
            if (cfg.match) return page.url.includes(cfg.match);
            if (remoteOrigin) return true;

            return page.url.startsWith('https://');
        },
        portFor: (platform) => {
            if (platform === 'android') return port;

            return explicitPort === undefined ? undefined : String(explicitPort);
        },
        selectDriver: () => resolveDriver(cfg.platform ?? 'auto'),
    };
};
