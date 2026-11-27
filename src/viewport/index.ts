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
//   --wl-scroll-room       space to add at the end of the page (padding-bottom) so its last fields
//                          can be scrolled above the keyboard; 0 where the WebView resized
//   [data-wl-keyboard]     "open" | "closed" on <html>
//
// Zero dependencies, no globals at import time: safe to import during SSR, where it does nothing.

import {
    EDITABLE,
    layoutViewportHeight,
    measureViewport,
    revealDelta,
    unobstructedBottom,
    type ViewportState,
    type ViewportTracker,
    visibleBottomInClient,
} from './compute.ts';

export {
    computeViewport,
    type LayoutElement,
    layoutViewportHeight,
    measureViewport,
    revealDelta,
    unobstructedBottom,
    type ViewportReading,
    type ViewportSample,
    type ViewportState,
    type ViewportTracker,
    visibleBottomInClient,
} from './compute.ts';

/** The parts of `window` this module reads (a test double in unit tests). */
export interface ViewportWindow {
    innerHeight: number;
    innerWidth: number;
    visualViewport?: {
        height: number;
        offsetTop: number;
        pageTop?: number;
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

/** The height `position: fixed` uses (not always `innerHeight`, see layoutViewportHeight). */
const layoutHeight = (win: ViewportWindow): number =>
    typeof document === 'undefined'
        ? win.innerHeight
        : layoutViewportHeight({
              innerHeight: win.innerHeight,
              clientHeight: document.documentElement.clientHeight,
              standardsMode: document.compatMode === 'CSS1Compat',
          });

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
    Math.abs(a.keyboardInset - b.keyboardInset) < 2 &&
    Math.abs(a.scrollRoom - b.scrollRoom) < 2;

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
                innerHeight: layoutHeight(win),
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
        element?.style.setProperty('--wl-scroll-room', `${state.scrollRoom}px`);
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
 * Keeps the focused field visible: when the keyboard or a fixed bar on it (a composer) covers the
 * field, scrolls it to the middle of the visible band above them, once the keyboard (and iOS
 * panning) settles. Fields at the end of the page need room to scroll into: give the page
 * `padding-bottom: var(--wl-scroll-room)` (a WKWebView in an app adds none for the keyboard).
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
        const visualHeight = viewport?.height ?? win.innerHeight;
        const visibleBottom = visibleBottomInClient({
            offsetTop: viewport?.offsetTop ?? 0,
            visualHeight,
            documentTop: document.documentElement.getBoundingClientRect().top,
            pageTop: viewport?.pageTop ?? window.scrollY,
        });
        // A fixed bar on the keyboard (a composer) hides what is right above the keyboard too.
        const bottom = unobstructedBottom<Element>(
            field,
            { width: win.innerWidth, visibleBottom },
            (x, y) => document.elementFromPoint(x, y),
            (element) => getComputedStyle(element).position,
        );
        const rect = field.getBoundingClientRect();
        const delta = revealDelta({
            top: rect.top,
            bottom: rect.bottom,
            visibleTop: visibleBottom - visualHeight,
            visibleBottom: bottom,
            margin,
        });

        if (delta !== 0) window.scrollBy({ top: delta, behavior: 'smooth' });
    };
    let settle: ReturnType<typeof setTimeout> | undefined;
    // iOS keeps panning the visual viewport for up to a second after focus: check once it is still.
    const onSettled = () => {
        clearTimeout(settle);
        settle = setTimeout(check, 200);
    };
    const onFocus = () => setTimeout(check, 350);

    document.addEventListener('focusin', onFocus);
    win.visualViewport?.addEventListener('resize', onSettled);
    win.visualViewport?.addEventListener('scroll', onSettled);

    return () => {
        clearTimeout(settle);
        document.removeEventListener('focusin', onFocus);
        win.visualViewport?.removeEventListener('resize', onSettled);
        win.visualViewport?.removeEventListener('scroll', onSettled);
    };
};
