import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickVisibleTarget } from '../src/cli/commands/keyboard.ts';
import type { InspectableTarget } from '../src/node/drivers/types.ts';

import {
    decodeKeyboardDrain,
    describeKeyboardSetup,
    formatKeyboardSample,
    type KeyboardSample,
    createKeyboardPrinter,
    keyboardProbeScript,
    watchKeyboard,
} from '../src/node/keyboard-probe.ts';

const sample = (over: Partial<KeyboardSample> = {}): KeyboardSample => ({
    t: 1000,
    reason: 'resize',
    innerWidth: 402,
    innerHeight: 874,
    visualHeight: 874,
    offsetTop: 0,
    baseline: 874,
    keyboardOpen: false,
    keyboardHeight: 0,
    keyboardInset: 0,
    focus: null,
    covered: null,
    hidden: false,
    pageVisible: true,
    barHeight: 0,
    atEnd: false,
    cssVars: {},
    metaViewport: 'width=device-width',
    ...over,
});

describe('webview-lens keyboard probe', () => {
    it('is a script the page can run, with the library keyboard math inlined', () => {
        const source = keyboardProbeScript({ overlay: true });

        assert.doesNotThrow(() => new Function(source));
        assert.match(source, /const computeViewport = /);
        assert.match(source, /setOverlay\(true\)/);
    });

    it('decodes drained samples and skips malformed ones', () => {
        const good = sample({ keyboardOpen: true, keyboardHeight: 336, keyboardInset: 336 });
        const drained = decodeKeyboardDrain(JSON.stringify([good, { t: 'x' }, 7]));

        assert.deepEqual(drained, [good]);
        assert.deepEqual(decodeKeyboardDrain(null), []);
        assert.deepEqual(decodeKeyboardDrain('{'), []);
    });

    it('prints a line per change of state, not per animation or scroll frame', () => {
        const closed = sample();
        const open = sample({
            t: 1200,
            keyboardOpen: true,
            keyboardHeight: 336,
            keyboardInset: 336,
            visualHeight: 538,
        });
        const scrolled = { ...open, t: 1220, reason: 'scroll' };
        const partly = sample({ ...open, t: 1300, focus: 'textarea#comment', covered: 40 });
        const hidden = sample({
            ...open,
            t: 1400,
            focus: 'input#message',
            covered: 90,
            hidden: true,
        });

        assert.match(
            formatKeyboardSample(closed, undefined) ?? '',
            /keyboard closed \| visible 874\/874/,
        );
        assert.match(
            formatKeyboardSample(open, closed) ?? '',
            /keyboard 336px, covers page 336px \| visible 538\/874/,
        );
        assert.equal(formatKeyboardSample(scrolled, open), null);
        assert.match(
            formatKeyboardSample(partly, open) ?? '',
            /focus textarea#comment partly hidden, bottom 40px below/,
        );
        assert.match(
            formatKeyboardSample(hidden, partly) ?? '',
            /focus input#message HIDDEN under the keyboard/,
        );
        assert.match(
            formatKeyboardSample({ ...partly, atEnd: true, barHeight: 67 }, undefined) ?? '',
            /fixed bar\); the page is at its end and cannot scroll it up: add padding-bottom: var\(--wl-scroll-room\)/,
        );
        assert.match(
            describeKeyboardSetup(sample({ cssVars: { '--wl-keyboard-inset': '0px' } })),
            /webview-lens\/viewport is active/,
        );
    });

    it('injects the probe, re-injects it after a navigation, and stops when the page closes', async () => {
        const evaluated: string[] = [];
        const lines: string[] = [];
        let closePage = () => undefined as void;
        const closed = new Promise<void>((resolve) => {
            closePage = resolve;
        });
        const drains = [
            JSON.stringify([sample({ reason: 'attach' })]),
            null,
            JSON.stringify([
                sample({
                    t: 2000,
                    keyboardOpen: true,
                    keyboardHeight: 300,
                    keyboardInset: 0,
                    visualHeight: 574,
                }),
            ]),
        ];
        let initScripts = 0;

        await watchKeyboard({
            session: {
                closed,
                addInitScript: async () => {
                    initScripts += 1;
                },
                evaluate: async (expression) => {
                    evaluated.push(expression.includes('drain()') ? 'drain' : 'probe');
                    if (!expression.includes('drain()')) return 'ok';
                    if (drains.length === 0) closePage();

                    return drains.shift();
                },
            },
            intervalMs: 1,
            log: (line) => lines.push(line),
        });

        assert.equal(initScripts, 1);
        assert.deepEqual(evaluated.slice(0, 4), ['probe', 'drain', 'drain', 'probe']);
        assert.match(lines[0] ?? '', /page 402×874, meta viewport: width=device-width/);
        assert.match(lines.at(-1) ?? '', /keyboard 300px, covers page 0px/);
    });

    it('prints milestones and the settled state, not every animation frame (iPhone 17 Pro, Flutter)', () => {
        // Recorded on iOS 26.6.1: the visual viewport shrinks first, then Flutter resizes the WebView.
        const base = { focus: 'input#address', innerWidth: 402, baseline: 697 };
        const frames = [
            sample({ ...base, reason: 'focusin', t: 37793 }),
            sample({
                ...base,
                reason: 'scroll',
                t: 37875,
                innerHeight: 697,
                visualHeight: 328,
                keyboardOpen: true,
                keyboardHeight: 369,
                keyboardInset: 369,
                covered: 143,
            }),
            sample({
                ...base,
                reason: 'scroll',
                t: 37917,
                innerHeight: 529,
                visualHeight: 328,
                offsetTop: 47,
                keyboardOpen: true,
                keyboardHeight: 322,
                keyboardInset: 154,
                covered: 27,
            }),
            sample({
                ...base,
                reason: 'scroll',
                t: 38129,
                innerHeight: 332,
                visualHeight: 328,
                keyboardOpen: true,
                keyboardHeight: 369,
                keyboardInset: 4,
                covered: 48,
            }),
            sample({
                ...base,
                reason: 'scroll',
                t: 38514,
                innerHeight: 328,
                visualHeight: 328,
                keyboardOpen: true,
                keyboardHeight: 369,
                keyboardInset: 0,
                covered: 0,
            }),
        ];
        const lines: string[] = [];
        const printAll = createKeyboardPrinter({ log: (line) => lines.push(line) });

        printAll(frames);
        printAll([]);

        assert.equal(lines.length, 3);
        assert.match(lines[0] ?? '', /focusin: keyboard closed/);
        assert.match(lines[1] ?? '', /keyboard 369px, covers page 369px/);
        assert.match(
            lines[2] ?? '',
            /keyboard 369px, covers page 0px \| visible 328\/328 \| focus input#address visible/,
        );

        const every: string[] = [];

        createKeyboardPrinter({ frames: true, log: (line) => every.push(line) })(frames);
        assert.equal(every.length, frames.length);
    });
});

describe('webview-lens keyboard: the visible WebView among several', () => {
    const target = (id: string): InspectableTarget => ({
        id,
        platform: 'ios',
        type: 'page',
        url: 'https://stand.test/',
        title: '',
        debuggerUrl: `ws://x/${id}`,
    });
    const session = (visibility: string) => {
        let closed = false;

        return {
            closedFlag: () => closed,
            value: {
                evaluate: async () => visibility,
                close: () => {
                    closed = true;
                },
            },
        };
    };

    it('skips a stale target that never connects and one behind another screen', async () => {
        const hidden = session('hidden');
        const visible = session('visible');
        const driver = {
            connectInspector: (t: InspectableTarget) => {
                if (t.id === 'stale') return new Promise<never>(() => undefined);

                return Promise.resolve((t.id === 'behind' ? hidden : visible).value);
            },
        };
        const picked = await pickVisibleTarget(
            driver,
            [target('stale'), target('behind'), target('front')],
            20,
        );

        assert.equal(picked?.id, 'front');
        assert.equal(hidden.closedFlag(), true);
        assert.equal(visible.closedFlag(), true);
    });

    it('returns undefined when none answers visible', async () => {
        const driver = {
            connectInspector: async () => session('hidden').value,
        };

        assert.equal(await pickVisibleTarget(driver, [target('a')], 20), undefined);
    });
});
