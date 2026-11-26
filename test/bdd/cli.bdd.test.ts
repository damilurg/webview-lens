import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const CLI_PATH = path.resolve(import.meta.dirname, '../../src/cli.ts');

const runCli = (
    args: string[],
    cwd: string,
): { status: number; stdout: string; stderr: string } => {
    try {
        const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        return { status: 0, stdout, stderr: '' };
    } catch (error) {
        const err = error as { status?: number; stdout?: string; stderr?: string };

        return {
            status: err.status ?? 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
        };
    }
};

describe('Feature: End-to-end CLI contracts and `webview-lens init` onboarding', () => {
    describe('Scenario: Running `webview-lens --help` lists Android & iOS commands', () => {
        it('Given the CLI entrypoint, When invoked with --help, Then exit code is 0 and all commands are documented', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-cli-help-'));
            const res = runCli(['--help'], dir);

            assert.equal(res.status, 0);
            assert.match(res.stdout, /Android & iOS/);
            assert.match(res.stdout, /webview-lens dev/);
            assert.match(res.stdout, /webview-lens devtools/);
            assert.match(res.stdout, /webview-lens vitals/);
            assert.match(res.stdout, /webview-lens cert/);
            assert.match(res.stdout, /webview-lens init/);
            assert.match(res.stdout, /webview-lens doctor/);
        });
    });

    describe('Scenario: `webview-lens init` generates a ready-to-use config for a Vite project', () => {
        it('Given a Vite workspace, When `init` runs, Then webview-lens.config.json is written with Vite defaults, refuses overwrite without --force, and overwrites with --force', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-cli-init-'));

            fs.writeFileSync(
                path.join(dir, 'package.json'),
                JSON.stringify({
                    scripts: { dev: 'vite' },
                    devDependencies: { vite: '^6.0.0', react: '^19.0.0' },
                }),
            );

            const first = runCli(
                ['init', '--remote', 'https://stand.example.test', '--app', 'com.example.debug'],
                dir,
            );

            assert.equal(first.status, 0);
            const configPath = path.join(dir, 'webview-lens.config.json');
            const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
                string,
                unknown
            >;

            assert.equal(written.platform, 'auto');
            assert.equal(written.preset, 'vite');
            assert.equal(written.local, 'http://localhost:5173');
            assert.equal(written.remote, 'https://stand.example.test');
            assert.equal(written.app, 'com.example.debug');
            assert.equal(written.cmd, 'npm run dev');
            assert.equal(written.logs, true);
            assert.deepEqual(written.ws, ['/']);

            // Second run without --force fails safely
            const second = runCli(['init'], dir);

            assert.equal(second.status, 1);
            assert.match(second.stderr, /already exists|--force/);

            // With --force overwrites cleanly
            const forced = runCli(['init', '--force', '--remote', 'https://new.example.test'], dir);

            assert.equal(forced.status, 0);
            const updated = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
                string,
                unknown
            >;

            assert.equal(updated.remote, 'https://new.example.test');
        });
    });

    describe('Scenario: Invalid CLI flags and unknown commands fail fast with exit code 1', () => {
        it('Given unknown command or invalid --platform/--preset/--throttle, When invoked, Then CLI exits 1 with a helpful message', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-cli-err-'));

            const badCmd = runCli(['unknown-cmd'], dir);

            assert.equal(badCmd.status, 1);
            assert.match(badCmd.stderr, /Unknown command/);

            const badPlatform = runCli(['doctor', '--platform', 'symbian'], dir);

            assert.equal(badPlatform.status, 1);
            assert.match(badPlatform.stderr, /Unknown --platform/);

            const badPreset = runCli(['dev', '--preset', 'esbuild'], dir);

            assert.equal(badPreset.status, 1);
            assert.match(badPreset.stderr, /Unknown --preset/);

            const badThrottle = runCli(['vitals', '--throttle', 'dialup'], dir);

            assert.equal(badThrottle.status, 1);
            assert.match(badThrottle.stderr, /Unknown --throttle/);

            const urlAsPath = runCli(['vitals', 'https://stand.example.test'], dir);

            assert.equal(urlAsPath.status, 1);
            assert.match(urlAsPath.stderr, /vitals takes paths such as \/ or \/orders/);
        });
    });
});
