// Project configuration loader (`webview-lens.config.json`) with strict validation and CLI merging.

import fs from 'node:fs';
import path from 'node:path';

import { errorMessage, isRecord } from '../shared/utils.ts';
import {
    isPlatformSelection,
    type NetworkThrottlePreset,
    type PlatformSelection,
} from './drivers/types.ts';
import { readPackageJson } from './fs-utils.ts';
import type { SsePolicy } from './override.ts';
import {
    detectPreset,
    isPresetSelection,
    PRESETS,
    type PresetName,
    type PresetSelection,
} from './presets.ts';
import { isNetworkThrottlePreset } from './vitals-lab.ts';

export const DEFAULT_CONFIG_FILE = 'webview-lens.config.json';

export interface ProjectConfig {
    platform?: PlatformSelection;
    preset?: PresetSelection;
    local?: string;
    remote?: string;
    remoteBase?: string;
    localBase?: string;
    cmd?: string;
    ws?: string[];
    hmrPorts?: number[];
    quiet?: string[];
    bypass?: string[];
    sse?: SsePolicy;
    forwarded?: boolean;
    port?: number | string;
    linkPort?: number | string;
    proxyPort?: number | string;
    serial?: string;
    app?: string;
    match?: string;
    logs?: boolean;
    throttle?: NetworkThrottlePreset;
    cpu?: number;
    budget?: string;
}

export interface LoadedProjectConfig {
    path: string | undefined;
    config: ProjectConfig;
}

const assertString = (obj: Record<string, unknown>, key: string): string | undefined => {
    const val = obj[key];

    if (val === undefined) return undefined;
    if (typeof val !== 'string') throw new Error(`Config "${key}" must be a string`);

    return val;
};

const assertStringArray = (obj: Record<string, unknown>, key: string): string[] | undefined => {
    const val = obj[key];

    if (val === undefined) return undefined;
    if (!Array.isArray(val) || !val.every((item) => typeof item === 'string')) {
        throw new Error(`Config "${key}" must be an array of strings`);
    }

    return [...val];
};

const assertPort = (value: unknown, field: string): number => {
    const num = typeof value === 'string' ? Number(value) : value;

    if (typeof num !== 'number' || !Number.isInteger(num) || num <= 0 || num > 65535) {
        throw new Error(`Config "${field}" must be a valid TCP port (1..65535)`);
    }

    return num;
};

const assertPortArray = (obj: Record<string, unknown>, key: string): number[] | undefined => {
    const val = obj[key];

    if (val === undefined) return undefined;
    if (!Array.isArray(val)) throw new Error(`Config "${key}" must be an array of TCP ports`);

    return val.map((item) => assertPort(item, key));
};

const assertPortLike = (obj: Record<string, unknown>, key: string): number | string | undefined => {
    const val = obj[key];

    if (val === undefined) return undefined;
    assertPort(val, key);

    return typeof val === 'string' || typeof val === 'number' ? val : undefined;
};

/** Validates untrusted JSON into a typed `ProjectConfig` using early-return guards. */
export const validateProjectConfig = (raw: unknown): ProjectConfig => {
    if (!isRecord(raw)) {
        throw new Error('webview-lens config must be a JSON object');
    }

    const config: ProjectConfig = {};

    const platform = assertString(raw, 'platform');

    if (platform !== undefined) {
        if (!isPlatformSelection(platform)) {
            throw new Error(`Invalid config "platform": "${platform}"`);
        }
        config.platform = platform;
    }

    const preset = assertString(raw, 'preset');

    if (preset !== undefined) {
        if (!isPresetSelection(preset)) {
            throw new Error(`Invalid config "preset": "${preset}"`);
        }
        config.preset = preset;
    }

    const sse = assertString(raw, 'sse');

    if (sse !== undefined) {
        if (sse !== 'fail' && sse !== 'continue') {
            throw new Error(`Invalid config "sse": "${sse}" (expected "fail" or "continue")`);
        }
        config.sse = sse;
    }

    const throttle = assertString(raw, 'throttle');

    if (throttle !== undefined) {
        if (!isNetworkThrottlePreset(throttle)) {
            throw new Error(`Invalid config "throttle": "${throttle}"`);
        }
        config.throttle = throttle;
    }

    if (raw.logs !== undefined) {
        if (typeof raw.logs !== 'boolean') throw new Error('Config "logs" must be a boolean');
        config.logs = raw.logs;
    }

    if (raw.forwarded !== undefined) {
        if (typeof raw.forwarded !== 'boolean') {
            throw new Error('Config "forwarded" must be a boolean');
        }
        config.forwarded = raw.forwarded;
    }

    if (raw.cpu !== undefined) {
        if (typeof raw.cpu !== 'number' || !Number.isFinite(raw.cpu) || raw.cpu < 1) {
            throw new Error('Config "cpu" must be a number >= 1');
        }
        config.cpu = raw.cpu;
    }

    const local = assertString(raw, 'local');
    const remote = assertString(raw, 'remote');
    const remoteBase = assertString(raw, 'remoteBase');
    const localBase = assertString(raw, 'localBase');
    const cmd = assertString(raw, 'cmd');
    const serial = assertString(raw, 'serial');
    const app = assertString(raw, 'app');
    const match = assertString(raw, 'match');
    const budget = assertString(raw, 'budget');
    const ws = assertStringArray(raw, 'ws');
    const quiet = assertStringArray(raw, 'quiet');
    const bypass = assertStringArray(raw, 'bypass');
    const hmrPorts = assertPortArray(raw, 'hmrPorts');
    const port = assertPortLike(raw, 'port');
    const linkPort = assertPortLike(raw, 'linkPort');
    const proxyPort = assertPortLike(raw, 'proxyPort');

    if (local !== undefined) config.local = local;
    if (remote !== undefined) config.remote = remote;
    if (remoteBase !== undefined) config.remoteBase = remoteBase;
    if (localBase !== undefined) config.localBase = localBase;
    if (cmd !== undefined) config.cmd = cmd;
    if (serial !== undefined) config.serial = serial;
    if (app !== undefined) config.app = app;
    if (match !== undefined) config.match = match;
    if (budget !== undefined) config.budget = budget;
    if (ws !== undefined) config.ws = ws;
    if (quiet !== undefined) config.quiet = quiet;
    if (bypass !== undefined) config.bypass = bypass;
    if (hmrPorts !== undefined) config.hmrPorts = hmrPorts;
    if (port !== undefined) config.port = port;
    if (linkPort !== undefined) config.linkPort = linkPort;
    if (proxyPort !== undefined) config.proxyPort = proxyPort;

    return config;
};

/** Loads `webview-lens.config.json` from `cwd` (or an explicit `configPath`). */
export const loadProjectConfig = ({
    cwd = process.cwd(),
    configPath,
}: {
    cwd?: string;
    configPath?: string;
} = {}): LoadedProjectConfig => {
    const resolved = configPath
        ? path.resolve(cwd, configPath)
        : path.join(cwd, DEFAULT_CONFIG_FILE);

    if (!fs.existsSync(resolved)) {
        if (configPath) throw new Error(`Config file not found: ${resolved}`);

        return { path: undefined, config: {} };
    }

    const rawText = fs.readFileSync(resolved, 'utf8');
    let parsed: unknown;

    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        throw new Error(`Invalid JSON in ${resolved}: ${errorMessage(error)}`);
    }

    return { path: resolved, config: validateProjectConfig(parsed) };
};

/** Every field of `ProjectConfig`, checked by the compiler in both directions. */
const CONFIG_KEYS = [
    'platform',
    'preset',
    'local',
    'remote',
    'remoteBase',
    'localBase',
    'cmd',
    'ws',
    'hmrPorts',
    'quiet',
    'bypass',
    'sse',
    'forwarded',
    'port',
    'linkPort',
    'proxyPort',
    'serial',
    'app',
    'match',
    'logs',
    'throttle',
    'cpu',
    'budget',
] as const satisfies readonly (keyof ProjectConfig)[];

// A new ProjectConfig field without an entry above fails to compile here.
type ExpectNever<T extends never> = T;
type MissingConfigKeys = ExpectNever<Exclude<keyof ProjectConfig, (typeof CONFIG_KEYS)[number]>>;

/** Copies one field when the source gives it (`undefined` means "not given"). */
const copyGiven = <K extends keyof ProjectConfig>(
    target: ProjectConfig,
    source: Partial<ProjectConfig>,
    key: K,
): void => {
    const value = source[key];

    if (value !== undefined) target[key] = value;
};

/** Merges CLI overrides on top of project config; explicit CLI fields always win. */
export const mergeCliConfig = (
    base: ProjectConfig,
    overrides: Partial<ProjectConfig>,
): ProjectConfig => {
    const merged: ProjectConfig = { ...base };

    for (const key of CONFIG_KEYS) copyGiven(merged, overrides, key);

    return merged;
};

const DEFAULT_PORT_BY_PRESET: Readonly<Record<PresetName, number>> = {
    vite: 5173,
    angular: 4200,
    next: 3000,
    nuxt: 3000,
    webpack: 3000,
    generic: 3000,
    sveltekit: 5173,
};

const detectDevCommand = (cwd: string): string | undefined => {
    const pkg = readPackageJson(cwd);

    if (!pkg || !isRecord(pkg.scripts)) return undefined;
    if (typeof pkg.scripts.dev === 'string') return 'npm run dev';
    if (typeof pkg.scripts.start === 'string') return 'npm start';

    return undefined;
};

export interface StarterConfigOptions {
    cwd?: string;
    configPath?: string;
    force?: boolean;
    remote?: string;
    app?: string;
}

/** Builds a ready-to-use starter `ProjectConfig` tailored to the workspace's bundler/scripts. */
export const buildStarterConfig = ({
    cwd = process.cwd(),
    remote,
    app,
}: StarterConfigOptions = {}): ProjectConfig => {
    const presetName = detectPreset(cwd);
    const preset = PRESETS[presetName];
    const port = DEFAULT_PORT_BY_PRESET[presetName];
    const cmd = detectDevCommand(cwd);

    return {
        platform: 'auto',
        preset: presetName,
        local: `http://localhost:${port}`,
        ...(remote ? { remote } : {}),
        ...(app ? { app } : {}),
        ...(cmd ? { cmd } : {}),
        ws: [...preset.wsPrefixes],
        logs: true,
    };
};

/** Writes `webview-lens.config.json` in `cwd` (refusing to overwrite unless `force: true`). */
export const writeStarterConfig = (options: StarterConfigOptions = {}): string => {
    const cwd = options.cwd ?? process.cwd();
    const target = options.configPath
        ? path.resolve(cwd, options.configPath)
        : path.join(cwd, DEFAULT_CONFIG_FILE);

    if (fs.existsSync(target) && !options.force) {
        throw new Error(`Config already exists at ${target} (pass --force to overwrite)`);
    }

    const config = buildStarterConfig(options);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(config, null, 4)}\n`);

    return target;
};
