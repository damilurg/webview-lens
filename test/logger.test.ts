import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
    configureLogging,
    createLogger,
    formatLogLine,
    type LogEntry,
    loggingFromEnv,
} from '../src/node/logger.ts';

describe('library logger', () => {
    let reset = () => undefined as void;

    afterEach(() => reset());

    it('is silent until configured, then routes entries by level', () => {
        const log = createLogger('adb');
        const seen: LogEntry[] = [];

        log.info('before configuration');
        reset = configureLogging({ sinks: [{ sink: (e) => seen.push(e), level: 'info' }] });
        log.debug('too detailed for this sink');
        log.info('forward tcp:9223 → webview_devtools_remote_1', { app: 'demo' });

        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.scope, 'adb');
        assert.deepEqual(seen[0]?.data, { app: 'demo' });
    });

    it('formats one readable stderr line', () => {
        const line = formatLogLine({
            time: '2026-11-25T12:01:02.345Z',
            level: 'debug',
            scope: 'ios-targets',
            message: 'target page-46 (page)',
            data: { queued: 1 },
        });

        assert.equal(
            line,
            '12:01:02.345 debug [webview-lens:ios-targets] target page-46 (page) {"queued":1}',
        );
    });

    it('writes JSON Lines to --log-file and never throws from a broken sink', () => {
        const file = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-log-')),
            'nested',
            'run.jsonl',
        );

        reset = configureLogging({
            file,
            sinks: [
                {
                    sink: () => {
                        throw new Error('disk full');
                    },
                },
            ],
        });
        assert.doesNotThrow(() => createLogger('mitm').warn('Proxy refused client'));

        const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as LogEntry;

        assert.equal(entry.scope, 'mitm');
        assert.equal(entry.level, 'warn');
    });

    it('reads WEBVIEW_LENS_DEBUG and WEBVIEW_LENS_LOG_FILE', () => {
        assert.deepEqual(
            loggingFromEnv({ WEBVIEW_LENS_DEBUG: '1', WEBVIEW_LENS_LOG_FILE: 'a.jsonl' }),
            {
                verbose: true,
                file: 'a.jsonl',
            },
        );
        assert.deepEqual(loggingFromEnv({}), { verbose: false });
    });
});
