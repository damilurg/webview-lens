// Lab Web Vitals from a real phone: screens open in the app's WebView over CDP, metrics are taken in
// the page (PerformanceObserver), the result is a table of medians.
//
// What is measured is whatever origin the WebView is on: the stand as it is, or the local server when
// `webview-lens dev` runs alongside. Dev server numbers are inflated (no minification, HMR): measure
// a production build for real ones.

import { connectCdp, getVersion, type PagePredicate } from './cdp.ts';
import { waitForPage, type WaitForPageOptions } from './device.ts';
import { METRIC_NAMES, type MetricName, rate, type Rating } from '../shared/thresholds.ts';

/** In-page collector, installed before the app's scripts on every load. */
export const COLLECTOR = `(() => {
    const v = (window.__webviewLensVitals = { lcp: null, fcp: null, cls: 0, inp: null, ttfb: null, shifts: [] });
    const observe = (type, cb, opts = {}) => {
        try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...opts }); } catch {}
    };
    observe('largest-contentful-paint', (e) => { v.lcp = e.startTime; v.lcpElement = e.element ? e.element.tagName.toLowerCase() + (e.element.className && typeof e.element.className === 'string' ? '.' + e.element.className.split(' ')[0].replace(/^.*?__/, '') : '') : null; });
    observe('paint', (e) => { if (e.name === 'first-contentful-paint') v.fcp = e.startTime; });
    // CLS by session windows (gap < 1 s, window < 5 s), as in web-vitals.
    let windowValue = 0, windowStart = 0, last = 0;
    observe('layout-shift', (e) => {
        if (e.hadRecentInput) return;
        if (e.startTime - last > 1000 || e.startTime - windowStart > 5000) { windowValue = 0; windowStart = e.startTime; }
        windowValue += e.value; last = e.startTime; v.cls = Math.max(v.cls, windowValue);
        if (e.value >= 0.01) v.shifts.push(+e.value.toFixed(3));
    });
    observe('event', (e) => { if (e.interactionId) v.inp = Math.max(v.inp ?? 0, e.duration); }, { durationThreshold: 16 });
    const nav = () => { const n = performance.getEntriesByType('navigation')[0]; if (n) v.ttfb = n.responseStart; };
    addEventListener('load', nav);
})();`;

export interface LabRun {
    lcp: number | null;
    fcp: number | null;
    cls: number | null;
    inp: number | null;
    ttfb: number | null;
    lcpElement?: string | null;
    shifts?: number[];
}

export type LabRow = Record<MetricName, number | null> & {
    path: string;
    lcpElement: string | null;
    shifts: number[];
};

export interface LabResult {
    origin: string;
    device: string;
    options: Required<Pick<LabOptions, 'runs' | 'cold' | 'interact'>>;
    rows: LabRow[];
}

export interface LabOptions {
    devtoolsPort: string | number;
    paths: readonly string[];
    /** Runs per screen, the median is reported. Default 3. */
    runs?: number;
    /** Disable the browser cache (first visit). */
    cold?: boolean;
    /** Seconds to tap around after load, for INP. Default 0: INP is not measured. */
    interact?: number;
    /** Wait after the load event for late paints and shifts. Default 4000 ms. */
    settleMs?: number;
    isTarget?: PagePredicate;
    log?: (line: string) => void;
    wait?: Omit<WaitForPageOptions, 'log'>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const median = (values: readonly (number | null | undefined)[]): number | null => {
    const list = values.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);

    if (list.length === 0) return null;
    if (list.length % 2) return list[mid] ?? null;

    return ((list[mid - 1] ?? 0) + (list[mid] ?? 0)) / 2;
};

export const formatMetric = (name: MetricName, value: number | null | undefined): string => {
    if (value === null || value === undefined) return '—';

    return name === 'CLS' ? value.toFixed(3) : `${Math.round(value)} ms`;
};

export const rateOrNone = (name: MetricName, value: number | null): Rating | null =>
    value === null ? null : rate(name, value);

export const measureVitals = async ({
    devtoolsPort,
    paths,
    runs = 3,
    cold = false,
    interact = 0,
    settleMs = 4000,
    isTarget = (page) => page.type === 'page' && /^https?:/.test(page.url),
    log = console.log,
    wait,
}: LabOptions): Promise<LabResult> => {
    const page = await waitForPage(devtoolsPort, isTarget, { ...wait, log });
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    const origin = new URL(page.url).origin;
    const version = await getVersion(devtoolsPort);
    const device = String(version['User-Agent'] ?? version.Browser ?? 'unknown');

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: cold });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECTOR });

    log(`Measuring ${origin}: ${paths.join(', ')} × ${runs}${cold ? ', cache disabled' : ''}`);

    const measure = async (url: string): Promise<LabRun | null> => {
        const loaded = cdp.once('Page.loadEventFired');

        await cdp.send('Page.navigate', { url });
        await Promise.race([loaded, sleep(30_000)]);
        await sleep(settleMs);

        if (interact > 0) {
            log(`  tap around for ${interact} s, for INP…`);
            await sleep(interact * 1000);
        }

        const { result } = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', {
            expression: 'JSON.stringify(window.__webviewLensVitals ?? null)',
            returnByValue: true,
        });

        return JSON.parse(result.value ?? 'null');
    };

    const rows: LabRow[] = [];

    try {
        for (const pagePath of paths) {
            const results: LabRun[] = [];

            for (let run = 1; run <= runs; run += 1) {
                const vitals = await measure(origin + pagePath);

                results.push(vitals ?? { lcp: null, fcp: null, cls: null, inp: null, ttfb: null });
                log(
                    `  ${pagePath} #${run}: LCP ${formatMetric('LCP', vitals?.lcp)}, CLS ${formatMetric('CLS', vitals?.cls)}`,
                );
            }

            const pick = (key: keyof Omit<LabRun, 'lcpElement' | 'shifts'>) =>
                median(results.map((r) => r[key]));
            const last = results.at(-1);

            rows.push({
                path: pagePath,
                LCP: pick('lcp'),
                FCP: pick('fcp'),
                CLS: pick('cls'),
                INP: pick('inp'),
                TTFB: pick('ttfb'),
                lcpElement: last?.lcpElement ?? null,
                shifts: last?.shifts ?? [],
            });
        }
    } finally {
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
        cdp.close();
    }

    return { origin, device, options: { runs, cold, interact }, rows };
};

const ICON: Record<Rating | 'none', string> = {
    good: '🟢',
    'needs-improvement': '🟡',
    poor: '🔴',
    none: '⚪',
};

/** Markdown report with ratings. */
export const toMarkdown = (
    { origin, device, options, rows }: LabResult,
    date = new Date(),
): string => {
    const cell = (name: MetricName, value: number | null) =>
        `${ICON[rateOrNone(name, value) ?? 'none']} ${formatMetric(name, value)}`;

    return [
        '# Web Vitals in the WebView',
        '',
        `- When: ${date.toISOString()}`,
        `- What: ${origin}`,
        `- Device: ${device}`,
        `- Runs per screen: ${options.runs} (median), cache: ${options.cold ? 'disabled' : 'normal'}, INP: ${options.interact ? `taps for ${options.interact} s` : 'not measured'}`,
        '',
        `| Screen | ${METRIC_NAMES.join(' | ')} | LCP element | Shifts ≥ 0.01 |`,
        `| --- | ${METRIC_NAMES.map(() => '---').join(' | ')} | --- | --- |`,
        ...rows.map(
            (row) =>
                `| \`${row.path}\` | ${METRIC_NAMES.map((m) => cell(m, row[m])).join(' | ')} | ${row.lcpElement ?? '—'} | ${row.shifts.join(', ') || '—'} |`,
        ),
        '',
        'web.dev thresholds: LCP ≤ 2.5 s, FCP ≤ 1.8 s, CLS ≤ 0.1, INP ≤ 200 ms, TTFB ≤ 0.8 s are 🟢; up to 4 s, 3 s, 0.25, 500 ms, 1.8 s are 🟡; above is 🔴.',
        '',
    ].join('\n');
};
