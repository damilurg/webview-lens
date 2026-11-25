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

export interface ViewportState {
    /** Visible height in CSS px (visual viewport). */
    height: number;
    /** Height of the on-screen keyboard, 0 when it is closed. */
    keyboardHeight: number;
    /** Part of the page (layout viewport) under the keyboard: 0 where the WebView resized. */
    keyboardInset: number;
    keyboardOpen: boolean;
}

export interface ViewportSample {
    /** `window.innerHeight` (layout viewport). */
    innerHeight: number;
    /** `visualViewport.height`, or innerHeight where visualViewport is missing. */
    visualHeight: number;
    /** `visualViewport.offsetTop`: how far the visual viewport scrolled inside the layout one. */
    offsetTop: number;
    /** Tallest layout height seen in this orientation: the height without the keyboard. */
    baseline: number;
}

/**
 * Keyboard state from one measurement. Covers both platforms: on Android the layout viewport
 * shrinks with the keyboard (baseline - innerHeight), on iOS only the visual one does
 * (innerHeight - visualHeight - offsetTop). Smaller gaps (toolbars, rounding) are not a keyboard.
 */
export const computeViewport = (
    { innerHeight, visualHeight, offsetTop, baseline }: ViewportSample,
    threshold = 120,
): ViewportState => {
    const keyboard = Math.max(
        0,
        Math.round(Math.max(baseline, innerHeight) - visualHeight - offsetTop),
    );
    const overlap = Math.max(0, Math.round(innerHeight - visualHeight - offsetTop));
    const keyboardOpen = keyboard > threshold;

    return {
        height: Math.round(visualHeight),
        keyboardHeight: keyboardOpen ? keyboard : 0,
        keyboardInset: keyboardOpen ? overlap : 0,
        keyboardOpen,
    };
};

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

const browserWindow = (): ViewportWindow | undefined =>
    typeof window === 'undefined' ? undefined : (window as unknown as ViewportWindow);

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
    let baseline = win.innerHeight;
    let width = win.innerWidth;
    let last = '';

    const update = () => {
        // A rotation changes the height without a keyboard: start the baseline over.
        if (Math.abs(win.innerWidth - width) > 50) {
            width = win.innerWidth;
            baseline = win.innerHeight;
        }

        const viewport = win.visualViewport;
        const state = computeViewport(
            {
                innerHeight: win.innerHeight,
                visualHeight: viewport?.height ?? win.innerHeight,
                offsetTop: viewport?.offsetTop ?? 0,
                baseline,
            },
            threshold,
        );

        if (!state.keyboardOpen) baseline = Math.max(baseline, win.innerHeight);

        const key = `${state.height}|${state.keyboardHeight}|${state.keyboardInset}`;

        if (key === last) return;
        last = key;
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

const EDITABLE =
    'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=""], [contenteditable="true"]';

export interface KeepFocusedVisibleOptions {
    /** Space to keep between the field and the keyboard, CSS px. Default 16. */
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
        const visibleBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight);

        if (field.getBoundingClientRect().bottom + margin <= visibleBottom) return;
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
