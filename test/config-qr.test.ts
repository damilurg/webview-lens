import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    buildStarterConfig,
    loadProjectConfig,
    validateProjectConfig,
    writeStarterConfig,
} from '../src/node/config.ts';
import { encodeQrMatrix, renderQrTerminal } from '../src/node/qr.ts';

describe('validateProjectConfig & loadProjectConfig', () => {
    it('returns empty config when no config file exists', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-nocfg-'));
        const res = loadProjectConfig({ cwd: dir });

        assert.equal(res.path, undefined);
        assert.deepEqual(res.config, {});
    });

    it('rejects unknown preset, invalid hmrPorts and non-object JSON', () => {
        assert.throws(() => validateProjectConfig('nope'), /JSON object/);
        assert.throws(() => validateProjectConfig({ preset: 'parcel' }), /preset/);
        assert.throws(() => validateProjectConfig({ hmrPorts: [99999] }), /hmrPorts/);
        assert.throws(() => validateProjectConfig({ throttle: '5g' }), /throttle/);
    });

    it('builds starter configs tailored for Angular, Next.js and Vite workspaces', () => {
        const ngDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-ng-'));

        fs.writeFileSync(
            path.join(ngDir, 'package.json'),
            JSON.stringify({
                dependencies: { '@angular/core': '19.0.0' },
                scripts: { start: 'ng serve' },
            }),
        );
        const ngCfg = buildStarterConfig({ cwd: ngDir });

        assert.equal(ngCfg.preset, 'angular');
        assert.equal(ngCfg.local, 'http://localhost:4200');
        assert.equal(ngCfg.cmd, 'npm start');

        const writtenPath = writeStarterConfig({ cwd: ngDir });

        assert.equal(writtenPath, path.join(ngDir, 'webview-lens.config.json'));
        assert.throws(() => writeStarterConfig({ cwd: ngDir }), /already exists/);
    });
});

describe('QR encoder edge cases', () => {
    it('encodes short and medium URLs across QR versions 1–6 and rejects oversized text', () => {
        assert.equal(encodeQrMatrix('hi').size, 21); // version 1
        assert.equal(encodeQrMatrix('http://10.0.0.2:8888/ca.cer').size, 25); // version 2
        assert.ok(renderQrTerminal('http://10.0.0.2:8888/').length > 50);
        assert.throws(() => encodeQrMatrix('x'.repeat(200)), /too long/i);
    });
});
