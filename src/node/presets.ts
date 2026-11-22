// Framework and bundler presets for `webview-lens dev`: sensible WebSocket bridge prefixes and
// quiet log filters out of the box, detected from package.json or picked explicitly via --preset.

import { isRecord } from '../shared/utils.ts';
import { readPackageJson } from './fs-utils.ts';

export type PresetName = 'next' | 'vite' | 'webpack' | 'nuxt' | 'angular' | 'generic';

export type PresetSelection = PresetName | 'auto';

export interface FrameworkPreset {
    name: PresetName;
    wsPrefixes: readonly string[];
    quietPrefixes: readonly string[];
}

export const PRESETS: Readonly<Record<PresetName, FrameworkPreset>> = {
    next: {
        name: 'next',
        wsPrefixes: ['/_next/'],
        quietPrefixes: ['/_next/static', '/__nextjs'],
    },
    vite: {
        name: 'vite',
        wsPrefixes: ['/'],
        quietPrefixes: ['/@vite', '/@fs', '/@id', '/@react-refresh', '/node_modules/.vite'],
    },
    webpack: {
        name: 'webpack',
        wsPrefixes: ['/ws'],
        quietPrefixes: ['/static/', '/hot-update'],
    },
    nuxt: {
        name: 'nuxt',
        wsPrefixes: ['/_nuxt/'],
        quietPrefixes: ['/_nuxt/'],
    },
    angular: {
        name: 'angular',
        wsPrefixes: ['/ng-cli-ws'],
        quietPrefixes: ['/@vite', '/@fs', '/assets/'],
    },
    generic: {
        name: 'generic',
        wsPrefixes: ['/'],
        quietPrefixes: [],
    },
};

export const PRESET_SELECTIONS: readonly PresetSelection[] = [
    'auto',
    'next',
    'vite',
    'webpack',
    'nuxt',
    'angular',
    'generic',
];

export const isPresetSelection = (value: string): value is PresetSelection =>
    (PRESET_SELECTIONS as readonly string[]).includes(value);

/** Picks the best preset from a merged dependencies map. */
export const detectPresetFromDependencies = (
    deps: Readonly<Record<string, unknown>>,
): PresetName => {
    if ('next' in deps) return 'next';
    if ('nuxt' in deps || 'nuxt3' in deps) return 'nuxt';
    if ('@angular/core' in deps || '@angular/cli' in deps) return 'angular';
    if ('vite' in deps) return 'vite';
    if ('webpack-dev-server' in deps || 'react-scripts' in deps || 'webpack' in deps) {
        return 'webpack';
    }

    return 'generic';
};

/** Detects the frontend bundler/framework from package.json in cwd. */
export const detectPreset = (cwd = process.cwd()): PresetName => {
    const pkg = readPackageJson(cwd);

    if (!pkg) return 'generic';

    const deps: Record<string, unknown> = {
        ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}),
        ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}),
    };

    return detectPresetFromDependencies(deps);
};

export const resolvePreset = (
    selection: PresetSelection = 'auto',
    cwd = process.cwd(),
): FrameworkPreset => {
    const name = selection === 'auto' ? detectPreset(cwd) : selection;

    return PRESETS[name];
};
