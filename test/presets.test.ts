import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    detectPreset,
    detectPresetFromDependencies,
    isPresetSelection,
    PRESETS,
    resolvePreset,
} from '../src/node/presets.ts';

describe('detectPresetFromDependencies', () => {
    it('detects next, nuxt, angular, vite, webpack and falls back to generic', () => {
        assert.equal(detectPresetFromDependencies({ next: '15.0.0', react: '19.0.0' }), 'next');
        assert.equal(detectPresetFromDependencies({ nuxt: '3.14.0', vite: '6.0.0' }), 'nuxt');
        assert.equal(
            detectPresetFromDependencies({ '@angular/core': '19.0.0', vite: '6.0.0' }),
            'angular',
        );
        assert.equal(detectPresetFromDependencies({ vite: '6.0.0', vue: '3.5.0' }), 'vite');
        assert.equal(
            detectPresetFromDependencies({ 'webpack-dev-server': '5.0.0', webpack: '5.90.0' }),
            'webpack',
        );
        assert.equal(detectPresetFromDependencies({ 'react-scripts': '5.0.1' }), 'webpack');
        assert.equal(detectPresetFromDependencies({ lodash: '4.17.21' }), 'generic');
    });
});

describe('detectPreset & resolvePreset', () => {
    it('reads dependencies and devDependencies from package.json in cwd', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-preset-'));

        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ dependencies: { vue: '3.5.0' }, devDependencies: { vite: '6.0.0' } }),
        );

        assert.equal(detectPreset(dir), 'vite');
        assert.deepEqual(resolvePreset('auto', dir), PRESETS.vite);
    });

    it('falls back to generic when package.json is absent or malformed', () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-empty-'));

        assert.equal(detectPreset(emptyDir), 'generic');

        fs.writeFileSync(path.join(emptyDir, 'package.json'), '{broken');
        assert.equal(detectPreset(emptyDir), 'generic');
    });

    it('validates preset selections', () => {
        assert.equal(isPresetSelection('auto'), true);
        assert.equal(isPresetSelection('vite'), true);
        assert.equal(isPresetSelection('unknown'), false);
    });
});
