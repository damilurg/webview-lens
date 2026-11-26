import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    computeViewport,
    measureViewport,
    unobstructedBottom,
    type ViewportWindow,
    watchViewport,
} from '../../src/viewport/index.ts';

/** A window whose sizes the test moves, firing resize on both viewports like a browser. */
const fakeWindow = (innerHeight: number, innerWidth = 390) => {
    const listeners = new Set<() => void>();
    const visualViewport = {
        height: innerHeight,
        offsetTop: 0,
        addEventListener: (_type: string, l: () => void) => listeners.add(l),
        removeEventListener: (_type: string, l: () => void) => listeners.delete(l),
    };
    const win: ViewportWindow = {
        innerHeight,
        innerWidth,
        visualViewport,
        addEventListener: (_type, l) => listeners.add(l),
        removeEventListener: (_type, l) => listeners.delete(l),
    };
    const resize = (layout: number, visual: number) => {
        win.innerHeight = layout;
        visualViewport.height = visual;
        for (const l of listeners) l();
    };

    return { win, resize, listeners };
};

const fakeTarget = () => {
    const vars: Record<string, string> = {};
    const attrs: Record<string, string> = {};

    return {
        vars,
        attrs,
        target: {
            style: { setProperty: (name: string, value: string) => void (vars[name] = value) },
            setAttribute: (name: string, value: string) => void (attrs[name] = value),
        },
    };
};

describe('webview-lens/viewport', () => {
    it('computes the keyboard on iOS (visual viewport shrinks) and Android (layout shrinks)', () => {
        // iOS WKWebView: layout stays 844, the visual viewport drops to 508.
        assert.deepEqual(
            computeViewport({ innerHeight: 844, visualHeight: 508, offsetTop: 0, baseline: 844 }),
            {
                height: 508,
                keyboardHeight: 336,
                keyboardInset: 336,
                keyboardOpen: true,
            },
        );
        // Android adjustResize: both shrink to 470 from a 780 baseline. The page is not covered
        // (the WebView resized), so fixed bars need no offset.
        assert.deepEqual(
            computeViewport({ innerHeight: 470, visualHeight: 470, offsetTop: 0, baseline: 780 }),
            { height: 470, keyboardHeight: 310, keyboardInset: 0, keyboardOpen: true },
        );
        // A 40 px toolbar change is not a keyboard.
        assert.equal(
            computeViewport({ innerHeight: 800, visualHeight: 760, offsetTop: 0, baseline: 800 })
                .keyboardOpen,
            false,
        );
    });

    it('writes CSS variables and data-wl-keyboard, and stops on unsubscribe', () => {
        const { win, resize, listeners } = fakeWindow(800);
        const { vars, attrs, target } = fakeTarget();
        const states: boolean[] = [];
        const stop = watchViewport({ win, target, onChange: (s) => states.push(s.keyboardOpen) });

        assert.equal(vars['--wl-keyboard-height'], '0px');
        assert.equal(attrs['data-wl-keyboard'], 'closed');

        resize(800, 480);
        assert.equal(vars['--wl-keyboard-height'], '320px');
        assert.equal(vars['--wl-keyboard-inset'], '320px');
        assert.equal(vars['--wl-viewport-height'], '480px');
        assert.equal(attrs['data-wl-keyboard'], 'open');

        resize(800, 800);
        assert.equal(attrs['data-wl-keyboard'], 'closed');
        assert.deepEqual(states, [false, true, false]);

        stop();
        assert.equal(listeners.size, 0);
    });

    it('ignores 1px jitter while the keyboard animates and rounding left after a resize', () => {
        const { win, resize } = fakeWindow(800);
        const { target } = fakeTarget();
        const insets: number[] = [];

        watchViewport({ win, target, onChange: (s) => insets.push(s.keyboardInset) });
        // Flutter on iOS: the WebView shrinks with the keyboard, leaving 0–2 px of rounding.
        resize(430, 430);
        resize(430, 429);
        resize(430, 430);
        resize(430, 429);
        assert.deepEqual(insets, [0, 0], 'closed, then one open state; no 1px updates');
        resize(430, 426);
        assert.equal(insets.length, 3, 'a 4px move is reported');
    });

    it('starts the baseline over after a rotation', () => {
        const { win, resize } = fakeWindow(800, 390);
        const { vars, target } = fakeTarget();

        watchViewport({ win, target });
        win.innerWidth = 844;
        resize(390, 390);
        assert.equal(vars['--wl-keyboard-height'], '0px', 'landscape height is not a keyboard');
    });

    it('does nothing on the server', () => {
        assert.doesNotThrow(() => watchViewport()());
    });
});

describe('measureViewport (found on iPhone 17 Pro, Flutter WKWebView)', () => {
    it('keeps the keyboard open when the WebView shrinks below its width', () => {
        // Flutter resizes the WKWebView with the keyboard: 402×697 becomes 402×385. Height alone
        // would look like a rotation to landscape and reset the baseline.
        const open = measureViewport(
            { width: 402, baseline: 697 },
            { innerWidth: 402, innerHeight: 385, visualHeight: 328, offsetTop: 0 },
        );

        assert.equal(open.state.keyboardOpen, true);
        assert.equal(open.state.keyboardHeight, 369);
        assert.deepEqual(open.tracker, { width: 402, baseline: 697 });
    });

    it('starts the baseline over on a real rotation', () => {
        const rotated = measureViewport(
            { width: 402, baseline: 697 },
            { innerWidth: 874, innerHeight: 380, visualHeight: 380, offsetTop: 0 },
        );

        assert.equal(rotated.state.keyboardOpen, false);
        assert.deepEqual(rotated.tracker, { width: 874, baseline: 380 });
    });

    it('follows a WebView that got shorter while no field was focused (native chrome grew)', () => {
        // iPhone 17 Pro: the Flutter screen grew a 17px status line, the WebView went 697 → 680.
        const settled = measureViewport(
            { width: 402, baseline: 697 },
            {
                innerWidth: 402,
                innerHeight: 680,
                visualHeight: 680,
                offsetTop: 0,
                editableFocused: false,
            },
        );
        const open = measureViewport(settled.tracker, {
            innerWidth: 402,
            innerHeight: 311,
            visualHeight: 311,
            offsetTop: 0,
            editableFocused: true,
        });

        assert.equal(settled.tracker.baseline, 680);
        assert.equal(open.state.keyboardHeight, 369);
    });

    it('does not lower the baseline while a field is focused and the keyboard is still opening', () => {
        const opening = measureViewport(
            { width: 392, baseline: 720 },
            {
                innerWidth: 392,
                innerHeight: 690,
                visualHeight: 690,
                offsetTop: 0,
                editableFocused: true,
            },
        );

        assert.equal(opening.state.keyboardOpen, false);
        assert.equal(opening.tracker.baseline, 720);
    });
});

describe('unobstructedBottom (found on iPhone 17 Pro: a composer bar hid the comment field)', () => {
    interface FakeElement {
        name: string;
        top: number;
        position: string;
        parentElement: FakeElement | null;
        contains(other: FakeElement | null): boolean;
        getBoundingClientRect(): { top: number };
    }

    const element = (
        name: string,
        top: number,
        position: string,
        parent: FakeElement | null = null,
    ): FakeElement => {
        const self: FakeElement = {
            name,
            top,
            position,
            parentElement: parent,
            contains: (other) => {
                for (let node = other; node; node = node.parentElement)
                    if (node === self) return true;

                return false;
            },
            getBoundingClientRect: () => ({ top }),
        };

        return self;
    };

    const body = element('body', 0, 'static');
    const composer = element('div.composer', 244, 'fixed', body);
    const composerInput = element('input#message', 252, 'static', composer);
    const comment = element('textarea#comment', 208, 'static', body);
    const positionOf = (e: FakeElement) => e.position;

    it('raises the visible bottom above a fixed bar on the keyboard', () => {
        const bottom = unobstructedBottom(
            comment,
            { width: 402, visibleBottom: 311 },
            () => composer,
            positionOf,
        );

        assert.equal(bottom, 244);
    });

    it('ignores the bar for a field inside it, and pages without bars', () => {
        assert.equal(
            unobstructedBottom(
                composerInput,
                { width: 402, visibleBottom: 311 },
                () => composerInput,
                positionOf,
            ),
            311,
        );
        assert.equal(
            unobstructedBottom(comment, { width: 402, visibleBottom: 311 }, () => body, positionOf),
            311,
        );
    });
});
