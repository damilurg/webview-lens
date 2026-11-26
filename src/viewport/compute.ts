// The keyboard math, without the DOM: used by the browser helpers in index.ts and injected as source
// into pages by `webview-lens keyboard` (computeViewport, nextBaseline and measureViewport must stay
// self-contained: no imports, only each other).

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
    // iOS overscroll ("rubber band") makes offsetTop negative for a moment: not a keyboard.
    const scrolled = Math.max(0, offsetTop);
    const keyboard = Math.max(
        0,
        Math.round(Math.max(baseline, innerHeight) - visualHeight - scrolled),
    );
    const covered = Math.max(0, Math.round(innerHeight - visualHeight - scrolled));
    // A few px left after the WebView resized (Flutter, adjustResize) is rounding, not keyboard.
    const overlap = covered < 4 ? 0 : covered;
    const keyboardOpen = keyboard > threshold;

    return {
        height: Math.round(visualHeight),
        keyboardHeight: keyboardOpen ? keyboard : 0,
        keyboardInset: keyboardOpen ? overlap : 0,
        keyboardOpen,
    };
};

/** Fields that bring up the on-screen keyboard. */
export const EDITABLE =
    'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/** What `measureViewport` carries between measurements. */
export interface ViewportTracker {
    /** Layout width the baseline belongs to. */
    width: number;
    /** Tallest keyboard-free layout height seen at that width. */
    baseline: number;
}

export interface ViewportReading {
    innerWidth: number;
    innerHeight: number;
    visualHeight: number;
    offsetTop: number;
    /**
     * Whether a text field has focus. False means the keyboard is certainly closed, so the current
     * height is the keyboard-free one even if it got smaller (native chrome around the WebView
     * grew). Unknown (undefined): the baseline only grows.
     */
    editableFocused?: boolean;
}

export const nextBaseline = (
    keyboardOpen: boolean,
    editableFocused: boolean | undefined,
    baseline: number,
    innerHeight: number,
): number => {
    if (keyboardOpen) return baseline;
    // No field focused: nothing can be covering the page, this is the real height.
    if (editableFocused === false) return innerHeight;

    // A field is focused but no keyboard yet: the first frames of it opening must not lower it.
    return Math.max(baseline, innerHeight);
};

/**
 * One measurement with its baseline bookkeeping: a width change over 50px is a rotation (start the
 * baseline over); the baseline only grows while the keyboard is closed. Height alone says nothing
 * about orientation: a WebView that shrinks with the keyboard (Flutter, adjustResize) can get
 * shorter than it is wide.
 */
export const measureViewport = (
    tracker: ViewportTracker,
    { innerWidth, innerHeight, visualHeight, offsetTop, editableFocused }: ViewportReading,
    threshold = 120,
): { state: ViewportState; tracker: ViewportTracker } => {
    const rotated = Math.abs(innerWidth - tracker.width) > 50;
    const baseline = rotated ? innerHeight : tracker.baseline;
    const state = computeViewport({ innerHeight, visualHeight, offsetTop, baseline }, threshold);

    return {
        state,
        tracker: {
            width: rotated ? innerWidth : tracker.width,
            baseline: nextBaseline(state.keyboardOpen, editableFocused, baseline, innerHeight),
        },
    };
};

/** The parts of a DOM element `unobstructedBottom` reads (structural, so this module needs no DOM). */
export interface LayoutElement<E> {
    readonly parentElement: E | null;
    contains(other: E | null): boolean;
    getBoundingClientRect(): { top: number };
}

/**
 * The lowest point a field can be seen at: the visible bottom, raised above fixed or sticky bars
 * that sit there (a composer riding on the keyboard, a tab bar). Probes three points along the
 * bottom edge; a bar that contains the field (the field is in the composer) does not count.
 */
export const unobstructedBottom = <E extends LayoutElement<E>>(
    field: E,
    { width, visibleBottom }: { width: number; visibleBottom: number },
    elementAt: (x: number, y: number) => E | null,
    positionOf: (element: E) => string,
): number => {
    let bottom = visibleBottom;

    for (const fraction of [0.1, 0.5, 0.9]) {
        let element = elementAt(width * fraction, visibleBottom - 1);

        while (element && !element.contains(field)) {
            const position = positionOf(element);

            if (position === 'fixed' || position === 'sticky') {
                bottom = Math.min(bottom, element.getBoundingClientRect().top);
                break;
            }
            element = element.parentElement;
        }
    }

    return bottom;
};
