import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeViewport, type ViewportWindow, watchViewport } from '../src/viewport/index.ts';

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
