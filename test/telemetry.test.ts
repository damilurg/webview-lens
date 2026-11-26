import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Cdp } from '../src/node/cdp.ts';
import {
    attachTelemetry,
    formatConsoleEvent,
    formatExceptionEvent,
    formatLocation,
    formatNetworkError,
    formatRemoteObject,
} from '../src/node/telemetry.ts';

describe('telemetry formatting helpers', () => {
    it('formats primitive, object preview and error remote objects', () => {
        assert.equal(formatRemoteObject({ type: 'string', value: 'hello' }), 'hello');
        assert.equal(formatRemoteObject({ type: 'number', value: 123 }), '123');
        assert.equal(formatRemoteObject({ type: 'undefined' }), 'undefined');
        assert.equal(formatRemoteObject({ type: 'object', subtype: 'null' }), 'null');
        assert.equal(
            formatRemoteObject({ type: 'object', description: 'TypeError: bad' }),
            'TypeError: bad',
        );
        assert.equal(
            formatRemoteObject({
                type: 'object',
                description: 'Object',
                preview: {
                    properties: [
                        { name: 'id', value: '42' },
                        { name: 'ok', value: 'true' },
                    ],
                },
            }),
            '{id: 42, ok: true}',
        );
        // A live exception carries an object preview too ({stack, message}): the Error text wins.
        assert.equal(
            formatRemoteObject({
                type: 'object',
                subtype: 'error',
                description: 'Error: boom\n    at onclick (https://stand/app.js:1:10)',
                preview: {
                    properties: [
                        { name: 'stack', value: 'Error: boom…' },
                        { name: 'message', value: 'boom' },
                    ],
                },
            }),
            'Error: boom\n    at onclick (https://stand/app.js:1:10)',
        );
    });

    it('formats locations with 1-based line and column numbers', () => {
        assert.equal(
            formatLocation('https://stand.example.test/src/app.ts', 0, 4),
            '/src/app.ts:1:5',
        );
        assert.equal(formatLocation('https://stand.example.test/src/app.ts', 11), '/src/app.ts:12');
        assert.equal(formatLocation(undefined, 1, 2), '');
    });

    it('formats console, exception and network error lines', () => {
        assert.equal(
            formatConsoleEvent({
                type: 'warning',
                args: [{ type: 'string', value: 'deprecated' }],
                stackTrace: {
                    callFrames: [
                        { url: 'https://stand.test/a.js', lineNumber: 2, columnNumber: 0 },
                    ],
                },
            }),
            '[console.warn] deprecated (/a.js:3:1)',
        );

        assert.equal(
            formatExceptionEvent({
                exceptionDetails: {
                    text: 'Uncaught',
                    url: 'https://stand.test/b.js',
                    lineNumber: 4,
                    columnNumber: 9,
                    exception: { type: 'object', description: 'Error: failed' },
                },
            }),
            '[exception] Error: failed (/b.js:5:10)',
        );

        assert.equal(
            formatNetworkError({
                kind: 'http',
                method: 'GET',
                status: 404,
                url: 'https://stand.test/missing',
            }),
            '[network] 404 GET https://stand.test/missing',
        );
    });
});

describe('attachTelemetry', () => {
    it('filters by console levels, ignores 2xx/3xx responses, and unsubscribes cleanly', () => {
        const listeners = new Map<string, Set<(params: unknown) => void>>();
        const cdp = {
            on: <T>(method: string, listener: (params: T) => void) => {
                const set = listeners.get(method) ?? new Set();
                const fn = listener as (params: unknown) => void;

                set.add(fn);
                listeners.set(method, set);

                return () => set.delete(fn);
            },
        } as Pick<Cdp, 'on'> as Cdp;

        const emit = (method: string, params: unknown) => {
            for (const fn of listeners.get(method) ?? []) fn(params);
        };

        const logs: string[] = [];
        const errors: string[] = [];
        const detach = attachTelemetry(cdp, {
            levels: ['warn', 'error'],
            log: (l) => logs.push(l),
            error: (e) => errors.push(e),
        });

        emit('Runtime.consoleAPICalled', {
            type: 'log',
            args: [{ type: 'string', value: 'ignored' }],
        });
        emit('Runtime.consoleAPICalled', {
            type: 'warning',
            args: [{ type: 'string', value: 'watch out' }],
        });
        emit('Network.requestWillBeSent', {
            requestId: 'ok-1',
            request: { url: 'https://stand.test/ok', method: 'GET' },
        });
        emit('Network.responseReceived', {
            requestId: 'ok-1',
            response: { url: 'https://stand.test/ok', status: 200 },
        });
        emit('Network.loadingFinished', { requestId: 'ok-1' });

        assert.deepEqual(logs, ['[console.warn] watch out']);
        assert.deepEqual(errors, []);

        detach();
        emit('Runtime.consoleAPICalled', {
            type: 'error',
            args: [{ type: 'string', value: 'after detach' }],
        });
        assert.deepEqual(errors, []);
    });
});

describe('attachTelemetry: what the page logged before the attach, and the default output', () => {
    const fakeCdp = () => {
        const listeners = new Map<string, Set<(params: unknown) => void>>();
        const cdp = {
            on: <T>(method: string, listener: (params: T) => void) => {
                const set = listeners.get(method) ?? new Set();
                const fn = listener as (params: unknown) => void;

                set.add(fn);
                listeners.set(method, set);

                return () => set.delete(fn);
            },
        } as Pick<Cdp, 'on'> as Cdp;
        const log = (text: string, timestamp?: number) => {
            for (const fn of listeners.get('Runtime.consoleAPICalled') ?? []) {
                fn({
                    type: 'log',
                    args: [{ type: 'string', value: text }],
                    ...(timestamp ? { timestamp } : {}),
                });
            }
        };

        return { cdp, log };
    };
    const ATTACH = 1_000_000;

    it('marks messages resent from the console history (older than 2 s), not fresh or undated ones', () => {
        const { cdp, log } = fakeCdp();
        const lines: string[] = [];

        attachTelemetry(cdp, { log: (l) => lines.push(l), now: () => ATTACH });
        log('an hour ago', ATTACH - 3_600_000);
        log('just over the margin', ATTACH - 2001);
        log('within the margin (device clock may run ahead)', ATTACH - 1999);
        log('after the attach', ATTACH + 50);
        log('no timestamp');

        assert.deepEqual(lines, [
            '[console.log] (earlier) an hour ago',
            '[console.log] (earlier) just over the margin',
            '[console.log] within the margin (device clock may run ahead)',
            '[console.log] after the attach',
            '[console.log] no timestamp',
        ]);
    });

    it("earlier: 'skip' drops the history and keeps the rest", () => {
        const { cdp, log } = fakeCdp();
        const lines: string[] = [];

        attachTelemetry(cdp, { log: (l) => lines.push(l), earlier: 'skip', now: () => ATTACH });
        log('old', ATTACH - 10_000);
        log('new', ATTACH + 1);

        assert.deepEqual(lines, ['[console.log] new']);
    });

    it('prints to stdout when no log is passed (the page console is what it is called for)', () => {
        const { cdp, log } = fakeCdp();
        const written: string[] = [];
        const original = process.stdout.write.bind(process.stdout);

        process.stdout.write = ((chunk: string) => {
            written.push(chunk);

            return true;
        }) as typeof process.stdout.write;
        try {
            const detach = attachTelemetry(cdp);

            log('hello');
            detach();
            log('after detach');
        } finally {
            process.stdout.write = original;
        }

        assert.deepEqual(written, ['[console.log] hello\n']);
    });
});
