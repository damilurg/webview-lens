// `webview-lens keyboard`: what the on-screen keyboard does to the page inside the app's WebView.
// A probe script records every viewport change (keyboard animation steps included) in the page; the
// CLI drains it over the inspector and prints one line per change. The keyboard math is the same
// computeViewport that webview-lens/viewport uses, injected as source.

import { bool, type Decoder, num, parseJson, rec, someOf, str } from '../shared/decode.ts';
import { isRecord, sleep, withTimeout } from '../shared/utils.ts';
import {
    computeViewport,
    EDITABLE,
    measureViewport,
    nextBaseline,
    unobstructedBottom,
} from '../viewport/compute.ts';
import type { InspectorSession } from './drivers/types.ts';

/** One measurement from the page. Lengths are CSS px. */
export interface KeyboardSample {
    /** `performance.now()` in the page, ms. */
    t: number;
    /** What triggered it: `attach`, `resize`, `scroll`, `focusin`, `blur`, `orientation`, `overlay`. */
    reason: string;
    innerWidth: number;
    innerHeight: number;
    visualHeight: number;
    offsetTop: number;
    baseline: number;
    keyboardOpen: boolean;
    keyboardHeight: number;
    keyboardInset: number;
    /** Focused element (`input#email`), or null. */
    focus: string | null;
    /** How far the focused element's bottom edge is below the visible area (0: fully visible). */
    covered: number | null;
    /** The focused element is entirely below the visible area (under the keyboard). */
    hidden: boolean;
    /** `document.visibilityState === 'visible'`: false for a WebView behind another screen. */
    pageVisible: boolean;
    /** Height of fixed/sticky bars at the visible bottom (a composer on the keyboard), CSS px. */
    barHeight: number;
    /** `--wl-*` custom properties on <html>, set when the page uses webview-lens/viewport. */
    cssVars: Record<string, string>;
    /** `<meta name="viewport">` content (`interactive-widget=` changes Android behaviour). */
    metaViewport: string | null;
}

const PROBE_GLOBAL = '__webviewLensKeyboard';
/** Bumped when the page side changes: a probe of another version is disposed and replaced. */
const PROBE_VERSION = 5;

/**
 * The page side: listeners on visualViewport, window and focus, a ring buffer of samples and an
 * optional overlay (a panel with the numbers, a line at the visible bottom, the focused field
 * outlined). Idempotent: running it again only switches the overlay.
 */
export const keyboardProbeScript = ({ overlay = false }: { overlay?: boolean } = {}): string => `
(() => {
    const existing = window.${PROBE_GLOBAL};
    if (existing && existing.version === ${PROBE_VERSION}) { existing.setOverlay(${overlay}); return 'ok'; }
    if (existing && existing.dispose) existing.dispose();
    const computeViewport = ${computeViewport.toString()};
    const nextBaseline = ${nextBaseline.toString()};
    const measureViewport = ${measureViewport.toString()};
    const EDITABLE = ${JSON.stringify(EDITABLE)};
    const unobstructedBottom = ${unobstructedBottom.toString()};
    const VARS = ['--wl-viewport-height', '--wl-keyboard-inset', '--wl-keyboard-height'];
    const buffer = [];
    let tracker = { width: innerWidth, baseline: innerHeight };
    let showOverlay = ${overlay};
    let panel = null, line = null, outlined = null, frame = 0, pending = 'attach';
    const describe = (el) => {
        if (!el || el === document.body || el === document.documentElement) return null;
        const name = el.getAttribute && el.getAttribute('name');
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (name ? '[name=' + name + ']' : '');
    };
    const draw = (s) => {
        if (!showOverlay) {
            if (panel) { panel.remove(); line.remove(); panel = line = null; }
            if (outlined) { outlined.style.outline = outlined.dataset.wlOutline || ''; outlined = null; }
            return;
        }
        if (!panel) {
            panel = document.createElement('div');
            line = document.createElement('div');
            panel.style.cssText = 'position:fixed;left:4px;z-index:2147483647;pointer-events:none;font:11px/1.35 ui-monospace,monospace;background:rgba(0,0,0,.78);color:#fff;padding:4px 6px;border-radius:4px;white-space:pre';
            line.style.cssText = 'position:fixed;left:0;right:0;height:2px;z-index:2147483647;pointer-events:none;background:#ff2d55';
            document.documentElement.append(panel, line);
        }
        panel.style.top = (s.offsetTop + 4) + 'px';
        line.style.top = (s.offsetTop + s.visualHeight - 2) + 'px';
        panel.textContent = 'keyboard ' + (s.keyboardOpen ? s.keyboardHeight + 'px' : 'closed') +
            '  inset ' + s.keyboardInset + '\\nvisible ' + s.visualHeight + ' of ' + s.innerHeight +
            '  offsetTop ' + s.offsetTop + (s.focus ? '\\nfocus ' + s.focus + (s.hidden ? '  HIDDEN' : s.covered ? '  bottom ' + s.covered + 'px below' : '  visible') : '');
        const el = document.activeElement;
        if (outlined && outlined !== el) { outlined.style.outline = outlined.dataset.wlOutline || ''; outlined = null; }
        if (s.focus && el && el.style) {
            if (outlined !== el) { el.dataset.wlOutline = el.style.outline; outlined = el; }
            el.style.outline = '2px solid ' + (s.hidden ? '#ff2d55' : s.covered ? '#ff9500' : '#34c759');
        }
    };
    const sample = (reason) => {
        const vv = window.visualViewport;
        const visualHeight = vv ? vv.height : innerHeight;
        const offsetTop = vv ? vv.offsetTop : 0;
        const active = document.activeElement;
        const editableFocused = !!(active && active.matches && active.matches(EDITABLE));
        const measured = measureViewport(tracker, { innerWidth, innerHeight, visualHeight, offsetTop, editableFocused });
        const state = measured.state;
        const baseline = measured.tracker.baseline;
        tracker = measured.tracker;
        const el = document.activeElement;
        const focus = describe(el);
        let covered = null, hidden = false, barHeight = 0;
        if (focus && el.getBoundingClientRect) {
            const rect = el.getBoundingClientRect();
            const visibleBottom = offsetTop + visualHeight;
            const bottom = unobstructedBottom(el, { width: innerWidth, visibleBottom },
                (x, y) => document.elementFromPoint(x, y), (e) => getComputedStyle(e).position);
            barHeight = Math.max(0, Math.round(visibleBottom - bottom));
            covered = Math.max(0, Math.round(rect.bottom - bottom));
            hidden = rect.top >= bottom;
        }
        const style = getComputedStyle(document.documentElement);
        const cssVars = {};
        for (const name of VARS) { const v = style.getPropertyValue(name).trim(); if (v) cssVars[name] = v; }
        const meta = document.querySelector('meta[name=viewport]');
        const s = {
            t: Math.round(performance.now()), reason, innerWidth, innerHeight,
            visualHeight: Math.round(visualHeight), offsetTop: Math.round(offsetTop), baseline,
            keyboardOpen: state.keyboardOpen, keyboardHeight: state.keyboardHeight, keyboardInset: state.keyboardInset,
            focus, covered, hidden, barHeight, pageVisible: document.visibilityState === 'visible', cssVars, metaViewport: meta ? meta.getAttribute('content') : null,
        };
        buffer.push(s);
        if (buffer.length > 300) buffer.shift();
        draw(s);
    };
    // One sample per frame: a keyboard animation fires many resize/scroll events.
    const schedule = (reason) => {
        pending = reason;
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; sample(pending); });
    };
    const stops = [];
    const listen = (target, type, fn, options) => {
        if (!target) return;
        target.addEventListener(type, fn, options);
        stops.push(() => target.removeEventListener(type, fn, options));
    };
    listen(window.visualViewport, 'resize', () => schedule('resize'));
    listen(window.visualViewport, 'scroll', () => schedule('scroll'));
    listen(window, 'resize', () => schedule('resize'));
    // The page (or keepFocusedInputVisible) scrolling the field into view: any scroller, captured.
    listen(document, 'scroll', () => schedule('scroll'), { capture: true, passive: true });
    listen(window, 'orientationchange', () => schedule('orientation'));
    listen(document, 'focusin', () => schedule('focusin'));
    // A screen pushed on top hides this WebView: requestAnimationFrame stops, so sample directly.
    listen(document, 'visibilitychange', () => sample('visibility'));
    // Focus moving between fields fires focusout then focusin: report only a real blur.
    listen(document, 'focusout', () => setTimeout(() => {
        if (!describe(document.activeElement)) schedule('blur');
    }, 0));
    window.${PROBE_GLOBAL} = {
        version: ${PROBE_VERSION},
        drain: () => JSON.stringify(buffer.splice(0)),
        setOverlay: (on) => { showOverlay = on; sample('overlay'); },
        dispose: () => { for (const stop of stops) stop(); showOverlay = false; draw(null); delete window.${PROBE_GLOBAL}; },
    };
    sample('attach');
    return 'ok';
})()`;

/** Reads the samples, if the probe is on the page (it is gone after a navigation until re-run). */
export const DRAIN_EXPRESSION = `window.${PROBE_GLOBAL} ? window.${PROBE_GLOBAL}.drain() : null`;

const decodeCssVars = (input: unknown): Record<string, string> => {
    const vars: Record<string, string> = {};

    for (const [name, value] of Object.entries(rec(input) ?? {})) {
        const text = str(value);

        if (text !== undefined) vars[name] = text;
    }

    return vars;
};

export const decodeKeyboardSample: Decoder<KeyboardSample> = (input) => {
    if (!isRecord(input)) return undefined;

    const t = num(input.t);
    const innerWidth = num(input.innerWidth);
    const innerHeight = num(input.innerHeight);
    const visualHeight = num(input.visualHeight);
    const offsetTop = num(input.offsetTop);
    const baseline = num(input.baseline);
    const keyboardOpen = bool(input.keyboardOpen);
    const keyboardHeight = num(input.keyboardHeight);
    const keyboardInset = num(input.keyboardInset);

    if (
        t === undefined ||
        innerWidth === undefined ||
        innerHeight === undefined ||
        visualHeight === undefined ||
        offsetTop === undefined ||
        baseline === undefined ||
        keyboardOpen === undefined ||
        keyboardHeight === undefined ||
        keyboardInset === undefined
    ) {
        return undefined;
    }

    return {
        t,
        reason: str(input.reason) ?? 'change',
        innerWidth,
        innerHeight,
        visualHeight,
        offsetTop,
        baseline,
        keyboardOpen,
        keyboardHeight,
        keyboardInset,
        focus: str(input.focus) ?? null,
        covered: num(input.covered) ?? null,
        hidden: bool(input.hidden) ?? false,
        pageVisible: bool(input.pageVisible) ?? true,
        barHeight: num(input.barHeight) ?? 0,
        cssVars: decodeCssVars(input.cssVars),
        metaViewport: str(input.metaViewport) ?? null,
    };
};

/** The probe's JSON string → samples (malformed entries skipped). */
export const decodeKeyboardDrain = (raw: unknown): KeyboardSample[] => {
    const text = str(raw);

    return text === undefined ? [] : (someOf(decodeKeyboardSample)(parseJson(text)) ?? []);
};

const focusVisibility = ({ hidden, covered, barHeight }: KeyboardSample): string => {
    // A fixed bar (composer) above the keyboard hides fields as well as the keyboard does.
    const behind = barHeight > 0 ? ` (keyboard + a ${barHeight}px fixed bar)` : '';

    if (hidden) return `HIDDEN${behind || ' under the keyboard'}`;
    if (covered) return `partly hidden, bottom ${covered}px below${behind}`;

    return 'visible';
};

/** The state in words: the keyboard, the visible area, the focused field, the --wl-* values. */
export const describeKeyboardState = (sample: KeyboardSample): string => {
    const keyboard = sample.keyboardOpen
        ? `keyboard ${sample.keyboardHeight}px, covers page ${sample.keyboardInset}px`
        : 'keyboard closed';
    const visible = `visible ${sample.visualHeight}/${sample.innerHeight}${sample.offsetTop ? ` (scrolled ${sample.offsetTop})` : ''}`;
    const focus =
        sample.focus === null ? '' : ` | focus ${sample.focus} ${focusVisibility(sample)}`;
    const vars = Object.entries(sample.cssVars)
        .map(([name, value]) => `${name.replace('--wl-', '')}=${value}`)
        .join(' ');

    return `${keyboard} | ${visible}${focus}${vars ? ` | ${vars}` : ''}`;
};

/** One terminal line per change of state; null when only the trigger differs (scroll frames). */
export const formatKeyboardSample = (
    sample: KeyboardSample,
    previous: KeyboardSample | undefined,
): string | null => {
    const state = describeKeyboardState(sample);

    if (previous && state === describeKeyboardState(previous)) return null;

    return `[keyboard] +${Math.round(sample.t)}ms ${sample.reason}: ${state}`;
};

/** First line after attaching: the page setup that decides how the keyboard behaves. */
export const describeKeyboardSetup = (sample: KeyboardSample): string => {
    const viewport =
        Object.keys(sample.cssVars).length > 0 ? ', webview-lens/viewport is active' : '';
    // The keyboard-free height is learnt from the page: attached with the keyboard up, it is not.
    const focused = sample.focus
        ? `\n[keyboard] attached with ${sample.focus} focused: close the keyboard once to measure it`
        : '';

    return `[keyboard] page ${sample.innerWidth}×${sample.innerHeight}, meta viewport: ${sample.metaViewport ?? '(none)'}${viewport}${focused}`;
};

/** A change worth a line right away: the keyboard opened or closed, focus moved, a field hid. */
const isMilestone = (sample: KeyboardSample, printed: KeyboardSample | undefined): boolean =>
    !printed ||
    sample.keyboardOpen !== printed.keyboardOpen ||
    sample.focus !== printed.focus ||
    sample.hidden !== printed.hidden;

/**
 * Turns the probe's samples into lines. By default one line per milestone and one when an animation
 * settles (no new samples for a poll), so opening the keyboard prints two or three lines, not forty;
 * `frames` prints every frame that changed something.
 */
export const createKeyboardPrinter = ({
    frames = false,
    log,
}: {
    frames?: boolean;
    log: (line: string) => void;
}) => {
    let printed: KeyboardSample | undefined;
    let pending: KeyboardSample | undefined;
    const print = (sample: KeyboardSample) => {
        const line = formatKeyboardSample(sample, printed);

        if (line) log(line);
        printed = sample;
        pending = undefined;
    };

    return (samples: readonly KeyboardSample[]): void => {
        if (samples.length === 0 && pending) print(pending);
        for (const sample of samples) {
            if (sample.reason === 'attach') {
                log(describeKeyboardSetup(sample));
                printed = undefined;
            }
            if (frames || isMilestone(sample, printed)) {
                print(sample);
                continue;
            }
            pending = sample;
        }
    };
};

/** Why `watchKeyboard` returned: the page closed, stopped answering, or went behind another screen. */
export type KeyboardWatchEnd = 'closed' | 'unresponsive' | 'hidden' | 'aborted';

export interface WatchKeyboardOptions {
    session: Pick<InspectorSession, 'evaluate' | 'addInitScript' | 'closed'>;
    overlay?: boolean;
    /** Every frame of a keyboard animation instead of milestones and settled states. */
    frames?: boolean;
    /** A page that does not answer a drain this long is treated as gone (a stale iOS target). */
    timeoutMs?: number;
    intervalMs?: number;
    log?: (line: string) => void;
    signal?: AbortSignal;
}

/**
 * Injects the probe (now and on every navigation) and prints the changes until the page closes or
 * `signal` aborts.
 */
export const watchKeyboard = async ({
    session,
    overlay = false,
    frames = false,
    intervalMs = 150,
    timeoutMs = 3000,
    log = console.log,
    signal,
}: WatchKeyboardOptions): Promise<KeyboardWatchEnd> => {
    const probe = keyboardProbeScript({ overlay });
    const printSamples = createKeyboardPrinter({ frames, log });
    let closed = false;

    void session.closed.then(() => {
        closed = true;
    });
    await session.addInitScript(probe);
    await session.evaluate(probe);

    for (;;) {
        if (closed) return 'closed';
        if (signal?.aborted) return 'aborted';

        const drained = await withTimeout(session.evaluate(DRAIN_EXPRESSION), timeoutMs);

        if (drained.timedOut) return 'unresponsive';
        // A navigation dropped the probe before the init script ran on the new document.
        if (drained.value === null) await session.evaluate(probe);

        const samples = decodeKeyboardDrain(drained.value);

        printSamples(samples);
        if (samples.some((sample) => !sample.pageVisible)) return 'hidden';
        await sleep(intervalMs);
    }
};
