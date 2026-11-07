import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadProjectConfig, mergeCliConfig, type ProjectConfig } from '../../src/node/config.ts';
import { encodeQrMatrix, renderQrTerminal } from '../../src/node/qr.ts';

describe('Feature: Zero-friction project config & terminal QR code for iOS CA', () => {
    describe('Scenario: Loading webview-lens.config.json and overriding individual fields from CLI', () => {
        it('Given a frontend workspace with webview-lens.config.json, When config is loaded and merged with CLI flags, Then CLI flags override config while omitted flags inherit from config', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-cfg-'));
            const configFile: ProjectConfig = {
                platform: 'android',
                preset: 'vite',
                local: 'http://localhost:5173',
                remote: 'https://stand.example.test',
                remoteBase: '/shop',
                localBase: '/',
                cmd: 'npm run dev',
                ws: ['/'],
                hmrPorts: [24678],
                bypass: ['/api/events'],
                logs: true,
                app: 'com.example.debug',
                budget: 'lcp=2200,cls=0.1',
            };

            fs.writeFileSync(
                path.join(dir, 'webview-lens.config.json'),
                JSON.stringify(configFile, null, 2),
            );

            const loaded = loadProjectConfig({ cwd: dir });

            assert.equal(loaded.path, path.join(dir, 'webview-lens.config.json'));
            assert.deepEqual(loaded.config, configFile);

            const merged = mergeCliConfig(loaded.config, {
                platform: 'ios',
                remote: 'https://override.example.test',
                logs: false,
            });

            assert.equal(merged.platform, 'ios');
            assert.equal(merged.remote, 'https://override.example.test');
            assert.equal(merged.remoteBase, '/shop');
            assert.equal(merged.preset, 'vite');
            assert.equal(merged.logs, false);
            assert.deepEqual(merged.hmrPorts, [24678]);
        });

        it('Given an invalid config file with bad types, When loadProjectConfig runs, Then it fails fast with a clear field error', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-cfg-bad-'));

            fs.writeFileSync(
                path.join(dir, 'webview-lens.config.json'),
                JSON.stringify({ platform: 'blackberry' }),
            );

            assert.throws(() => loadProjectConfig({ cwd: dir }), /platform/i);
        });
    });

    describe('Scenario: Generating a scannable terminal QR code for the iOS .mobileconfig URL', () => {
        it('Given a LAN URL for the iOS Root CA profile, When QR matrix and terminal output are generated, Then finder patterns are valid and UTF-8 half-block output renders cleanly', () => {
            const url = 'http://192.168.1.42:8888/webview-lens.mobileconfig';
            const matrix = encodeQrMatrix(url);

            // Standard QR dimensions: 21 + 4*(version - 1)
            assert.equal((matrix.size - 21) % 4, 0);
            assert.ok(matrix.size >= 29);

            // Top-left 7x7 finder pattern outer ring is dark (true) and inner 5x5 ring is light (false).
            for (let i = 0; i < 7; i += 1) {
                assert.equal(matrix.get(0, i), true);
                assert.equal(matrix.get(6, i), true);
                assert.equal(matrix.get(i, 0), true);
                assert.equal(matrix.get(i, 6), true);
            }
            assert.equal(matrix.get(1, 1), false);
            assert.equal(matrix.get(3, 3), true);

            // Timing pattern on row 6 alternates dark/light starting dark at col 8.
            assert.equal(matrix.get(6, 8), true);
            assert.equal(matrix.get(6, 9), false);
            assert.equal(matrix.get(6, 10), true);

            const rendered = renderQrTerminal(url);
            const lines = rendered.split('\n');

            assert.ok(lines.length > 10);
            assert.match(rendered, /[█▀▄ ]/);
        });
    });
});
