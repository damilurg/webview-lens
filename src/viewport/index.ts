// Keyboard and viewport helpers for pages inside Android WebView and iOS WKWebView.
//
// The on-screen keyboard behaves differently in each container: Android (adjustResize) shrinks the
// layout viewport, iOS WKWebView keeps it and only shrinks the visual viewport, and `100vh` follows
// neither. A bottom bar ends up under the keyboard, a focused field below it. This module measures the
// visual viewport and exposes it to CSS:
//
//   --wl-viewport-height   visible height (use instead of 100vh)
//   --wl-keyboard-inset    how much of the page the keyboard covers: use it for `bottom:` of fixed
//                          bars. iOS: the keyboard height. Android adjustResize: 0 (the WebView
//                          already shrank), so the same CSS is right on both.
//   --wl-keyboard-height   the keyboard height itself (0 when closed)
//   [data-wl-keyboard]     "open" | "closed" on <html>
//
// Zero dependencies, no globals at import time: safe to import during SSR, where it does nothing.

import {
    EDITABLE,
    measureViewport,
    unobstructedBottom,
    type ViewportState,
    type ViewportTracker,
} from './compute.ts';

export {
    computeViewport,
    type LayoutElement,
    measureViewport,
    unobstructedBottom,
    type ViewportReading,
    type ViewportSample,
    type ViewportState,
    type ViewportTracker,
} from './compute.ts';

/** The parts of `window` this module reads (a test double in unit tests). */
export interface ViewportWindow {
    innerHeight: number;
    innerWidth: number;
    visualViewport?: {
        height: number;
        offsetTop: number;
        addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
        removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
    } | null;
    addEventListener(type: 'resize' | 'orientationchange', listener: () => void): void;
    removeEventListener(type: 'resize' | 'orientationchange', listener: () => void): void;
}

export interface WatchViewportOptions {
    /** Element that receives the CSS variables and data attribute. Default: `<html>`. */
    target?: {
        style: { setProperty(name: string, value: string): void };
        setAttribute(name: string, value: string): void;
    };
    onChange?: (state: ViewportState) => void;
    /** Covered height above which the keyboard counts as open, CSS px. Default 120. */
    threshold?: number;
    win?: ViewportWindow;
}

/** A text field has focus, so the keyboard may be up (no focus: it is certainly down). */
const isEditableFocused = (): boolean | undefined => {
    if (typeof document === 'undefined') return undefined;

    const field = document.activeElement;

    return field instanceof HTMLElement && field.matches(EDITABLE);
};

const isSameState = (a: ViewportState, b: ViewportState): boolean =>
    a.keyboardOpen === b.keyboardOpen &&
    Math.abs(a.height - b.height) < 2 &&
    Math.abs(a.keyboardHeight - b.keyboardHeight) < 2 &&
    Math.abs(a.keyboardInset - b.keyboardInset) < 2;

const browserWindow = (): ViewportWindow | undefined =>
    typeof window === 'undefined' ? undefined : window;

/**
 * Keeps `--wl-viewport-height`, `--wl-keyboard-inset`, `--wl-keyboard-height` and
 * `data-wl-keyboard` up to date.
 * Returns a function that stops watching. A no-op on the server.
 */
export const watchViewport = ({
    target,
    onChange,
    threshold = 120,
    win = browserWindow(),
}: WatchViewportOptions = {}): (() => void) => {
    if (!win) return () => undefined;

    const element =
        target ?? (typeof document === 'undefined' ? undefined : document.documentElement);
    let tracker: ViewportTracker = { width: win.innerWidth, baseline: win.innerHeight };
    let last: ViewportState | undefined;

    const update = () => {
        const viewport = win.visualViewport;
        const measured = measureViewport(
            tracker,
            {
                innerWidth: win.innerWidth,
                innerHeight: win.innerHeight,
                visualHeight: viewport?.height ?? win.innerHeight,
                offsetTop: viewport?.offsetTop ?? 0,
                editableFocused: isEditableFocused(),
            },
            threshold,
        );
        const { state } = measured;

        tracker = measured.tracker;

        // The keyboard animates over several frames: report it open/closed and when a size moves
        // by 2px or more, not every 1px step.
        if (last && isSameState(last, state)) return;
        last = state;
        element?.style.setProperty('--wl-viewport-height', `${state.height}px`);
        element?.style.setProperty('--wl-keyboard-height', `${state.keyboardHeight}px`);
        element?.style.setProperty('--wl-keyboard-inset', `${state.keyboardInset}px`);
        element?.setAttribute('data-wl-keyboard', state.keyboardOpen ? 'open' : 'closed');
        onChange?.(state);
    };

    win.visualViewport?.addEventListener('resize', update);
    win.visualViewport?.addEventListener('scroll', update);
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', update);
    update();

    return () => {
        win.visualViewport?.removeEventListener('resize', update);
        win.visualViewport?.removeEventListener('scroll', update);
        win.removeEventListener('resize', update);
        win.removeEventListener('orientationchange', update);
    };
};

export interface KeepFocusedVisibleOptions {
    /** Space to keep between the field and the keyboard (or a fixed bar on it), CSS px. Default 16. */
    margin?: number;
    win?: ViewportWindow;
}

/**
 * When the keyboard opens over the focused field (iOS WKWebView does not scroll for you inside
 * fixed layouts; Android stops short with adjustPan), scroll it to the middle of what is visible.
 * Returns a function that stops it. A no-op on the server.
 */
export const keepFocusedInputVisible = ({
    margin = 16,
    win = browserWindow(),
}: KeepFocusedVisibleOptions = {}): (() => void) => {
    if (!win || typeof document === 'undefined') return () => undefined;

    const check = () => {
        const field = document.activeElement;

        if (!(field instanceof HTMLElement) || !field.matches(EDITABLE)) return;

        const viewport = win.visualViewport;
        // A fixed bar on the keyboard (a composer) hides what is right above the keyboard too.
        const bottom = unobstructedBottom<Element>(
            field,
            {
                width: win.innerWidth,
                visibleBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight),
            },
            (x, y) => document.elementFromPoint(x, y),
            (element) => getComputedStyle(element).position,
        );

        if (field.getBoundingClientRect().bottom + margin <= bottom) return;
        field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    // The keyboard animates in after focus: check again once it has settled.
    const onFocus = () => setTimeout(check, 350);

    document.addEventListener('focusin', onFocus);
    win.visualViewport?.addEventListener('resize', check);

    return () => {
        document.removeEventListener('focusin', onFocus);
        win.visualViewport?.removeEventListener('resize', check);
    };
};
