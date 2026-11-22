import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    findFileInDirs,
    isFile,
    killProcessTree,
    listDirs,
    readPackageJson,
} from '../src/node/fs-utils.ts';
import { errorMessage, isRecord, sleep, waitWithTimeout } from '../src/shared/utils.ts';

describe('shared/utils (Edge-safe runtime helpers)', () => {
    it('isRecord matches plain objects and rejects null, primitives and arrays', () => {
        assert.equal(isRecord({ a: 1 }), true);
        assert.equal(isRecord({}), true);
        assert.equal(isRecord(null), false);
        assert.equal(isRecord(undefined), false);
        assert.equal(isRecord([]), false);
        assert.equal(isRecord('text'), false);
        assert.equal(isRecord(42), false);
    });

    it('errorMessage extracts Error.message and stringifies arbitrary thrown values', () => {
        assert.equal(errorMessage(new Error('boom')), 'boom');
        assert.equal(errorMessage('plain'), 'plain');
        assert.equal(errorMessage(404), '404');
    });

    it('sleep resolves after delay and waitWithTimeout resolves without dangling timers', async () => {
        const start = Date.now();

        await sleep(10);
        assert.ok(Date.now() - start >= 5);

        // Resolves immediately when promise settles first (timer cleared in finally).
        await waitWithTimeout(Promise.resolve('done'), 10_000);

        // Resolves cleanly when timeout fires before a never-settling promise.
        await waitWithTimeout(new Promise(() => undefined), 10);
    });
});

describe('node/fs-utils (filesystem & process helpers)', () => {
    it('finds nested files, lists directories and reads package.json safely', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-lens-fs-utils-'));

        try {
            const nested = path.join(tmp, 'release', 'platform-tools');

            fs.mkdirSync(nested, { recursive: true });
            const targetFile = path.join(nested, 'adb');

            fs.writeFileSync(targetFile, '');
            fs.writeFileSync(
                path.join(tmp, 'package.json'),
                JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }),
            );

            assert.equal(isFile(targetFile), true);
            assert.equal(isFile(nested), false);
            assert.equal(isFile(path.join(tmp, 'missing')), false);
            assert.deepEqual(listDirs(tmp), [path.join(tmp, 'release')]);
            assert.deepEqual(listDirs(path.join(tmp, 'missing')), []);

            assert.equal(findFileInDirs(tmp, ['platform-tools', 'adb'], 2), targetFile);
            assert.equal(findFileInDirs(tmp, ['platform-tools', 'adb'], 0), undefined);

            const pkg = readPackageJson(tmp);

            assert.equal(pkg?.name, 'demo');
            assert.equal(readPackageJson(path.join(tmp, 'missing')), undefined);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('killProcessTree skips already exited or pid-less processes and sends SIGTERM on POSIX', () => {
        const killed: (NodeJS.Signals | number | undefined)[] = [];

        killProcessTree(
            {
                pid: 1234,
                exitCode: 0,
                kill(sig) {
                    killed.push(sig);

                    return true;
                },
            },
            'darwin',
        );
        killProcessTree(
            {
                pid: undefined,
                exitCode: null,
                kill(sig) {
                    killed.push(sig);

                    return true;
                },
            },
            'darwin',
        );
        assert.equal(killed.length, 0);

        killProcessTree(
            {
                pid: 9999,
                exitCode: null,
                kill(sig) {
                    killed.push(sig);

                    return true;
                },
            },
            'darwin',
        );
        assert.deepEqual(killed, ['SIGTERM']);
    });
});
