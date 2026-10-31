// Lab Web Vitals from a real phone: screens open in the app's WebView over CDP, metrics are taken in
// the page (PerformanceObserver), the result is a table of medians.
//
// What is measured is whatever origin the WebView is on: the stand as it is, or the local server when
// `webview-lens dev` runs alongside. Dev server numbers are inflated (no minification, HMR): measure
// a production build for real ones.

import type { WaitForPageOptions } from './device.ts';
import { createAndroidDriver } from './drivers/android.ts';
import type {
    DeviceDriver,
    DriverTargetOptions,
    InspectableTarget,
    InspectorCapabilities,
    NetworkThrottlePreset,
} from './drivers/types.ts';
import {
    isMetricName,
    METRIC_NAMES,
    type MetricName,
    rate,
    type Rating,
} from '../shared/thresholds.ts';

/** In-page collector, installed before the app's scripts on every load. */
export const COLLECTOR = `(() => {
    const v = (window.__webviewLensVitals = { lcp: null, fcp: null, cls: 0, inp: null, ttfb: null, shifts: [], longTasksCount: 0, longTasksTotalMs: 0, marks: {} });
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
    observe('longtask', (e) => { v.longTasksCount += 1; v.longTasksTotalMs += Math.round(e.duration); });
    const nav = () => {
        const n = performance.getEntriesByType('navigation')[0];
        if (n) v.ttfb = n.responseStart;
        for (const m of performance.getEntriesByType('mark')) { v.marks[m.name] = Math.round(m.startTime); }
    };
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
    longTasksCount?: number;
    longTasksTotalMs?: number;
    marks?: Record<string, number>;
}

export const NETWORK_THROTTLE_PRESETS: readonly NetworkThrottlePreset[] = [
    'none',
    'fast-4g',
    'slow-4g',
    '3g',
];

export const isNetworkThrottlePreset = (value: string): value is NetworkThrottlePreset =>
    (NETWORK_THROTTLE_PRESETS as readonly string[]).includes(value);

export type LabRow = Record<MetricName, number | null> & {
    path: string;
    lcpElement: string | null;
    shifts: number[];
    longTasks?: { count: number; totalMs: number };
    marks?: Record<string, number>;
    jsHeapMb?: number;
};

export interface LabResult {
    origin: string;
    device: string;
    capabilities?: InspectorCapabilities;
    options: Required<Pick<LabOptions, 'runs' | 'cold' | 'interact'>>;
    rows: LabRow[];
}

export type BudgetThresholds = Partial<Record<MetricName, number>>;

export interface BudgetViolation {
    path: string;
    metric: MetricName;
    actual: number;
    limit: number;
}

/** Parses a budget string like `"lcp=2500,cls=0.1,ttfb=800"` into checked thresholds. */
export const parseBudgets = (spec: string): BudgetThresholds => {
    const budgets: BudgetThresholds = {};

    for (const part of spec
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const [rawMetric, rawValue] = part.split('=').map((s) => s.trim());
        const metric = rawMetric?.toUpperCase();

        if (!metric || !isMetricName(metric)) {
            throw new Error(
                `Unknown budget metric "${rawMetric ?? ''}". Expected one of: ${METRIC_NAMES.join(', ')}`,
            );
        }

        const limit = Number(rawValue);

        if (!rawValue || !Number.isFinite(limit) || limit < 0) {
            throw new Error(`Invalid budget value "${rawValue ?? ''}" for ${metric}`);
        }
        budgets[metric] = limit;
    }

    return budgets;
};

/** Checks measured lab rows against performance budgets; returns every exceeded metric. */
export const checkBudgets = (result: LabResult, budgets: BudgetThresholds): BudgetViolation[] => {
    const violations: BudgetViolation[] = [];

    for (const row of result.rows) {
        for (const metric of METRIC_NAMES) {
            const limit = budgets[metric];
            const actual = row[metric];

            if (limit !== undefined && actual !== null && actual > limit) {
                violations.push({ path: row.path, metric, actual, limit });
            }
        }
    }

    return violations;
};

export interface LabOptions {
    devtoolsPort?: string | number;
    /** Optional DeviceDriver (Android, iOS, or fake for testing). Defaults to AndroidDriver. */
    driver?: DeviceDriver;
    paths: readonly string[];
    /** Runs per screen, the median is reported. Default 3. */
    runs?: number;
    /** Disable the browser cache (first visit). */
    cold?: boolean;
    /** Seconds to tap around after load, for INP. Default 0: INP is not measured. */
    interact?: number;
    /** Network throttling profile (Android CDP). Default: `'none'`. */
    throttle?: NetworkThrottlePreset;
    /** CPU slowdown multiplier (e.g. `4` = 4x slowdown, Android CDP). Default: `1`. */
    cpu?: number;
    /** Wait after the load event for late paints and shifts. Default 4000 ms. */
    settleMs?: number;
    isTarget?: (target: Pick<InspectableTarget, 'id' | 'type' | 'url' | 'title'>) => boolean;
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
    devtoolsPort = '9223',
    driver,
    paths,
    runs = 3,
    cold = false,
    interact = 0,
    throttle = 'none',
    cpu = 1,
    settleMs = 4000,
    isTarget = (target) => target.type === 'page' && /^https?:/.test(target.url),
    log = console.log,
    wait,
}: LabOptions): Promise<LabResult> => {
    const activeDriver =
        driver ??
        createAndroidDriver({
            ...(wait?.run ? { runAdb: wait.run } : {}),
            defaultPort: devtoolsPort,
        });
    const targetOptions: DriverTargetOptions = {
        port: devtoolsPort,
        log,
        ...(wait?.serial ? { serial: wait.serial } : {}),
        ...(wait?.app ? { app: wait.app } : {}),
        ...(wait?.intervalMs !== undefined ? { intervalMs: wait.intervalMs } : {}),
        ...(wait?.signal ? { signal: wait.signal } : {}),
    };

    const target = await activeDriver.waitForTarget(
        (candidate) => isTarget(candidate),
        targetOptions,
    );
    const session = await activeDriver.connectInspector(target);
    const origin = new URL(target.url).origin;
    const device = await activeDriver.getDeviceDescription(targetOptions);

    await session.setCacheDisabled(cold);
    if (throttle !== 'none') {
        if (session.setNetworkThrottle) await session.setNetworkThrottle(throttle);
        else log(`Note: network throttling (${throttle}) is not supported on ${session.platform}`);
    }
    if (cpu > 1) {
        if (session.setCpuThrottle) await session.setCpuThrottle(cpu);
        else log(`Note: CPU throttling (${cpu}x) is not supported on ${session.platform}`);
    }
    await session.addInitScript(COLLECTOR);

    log(`Measuring ${origin}: ${paths.join(', ')} × ${runs}${cold ? ', cache disabled' : ''}`);

    const measure = async (
        url: string,
    ): Promise<{ vitals: LabRun | null; jsHeapMb: number | null }> => {
        await session.navigate(url, { waitForLoad: true, timeoutMs: 30_000 });
        if (settleMs > 0) await sleep(settleMs);

        if (interact > 0) {
            log(`  tap around for ${interact} s, for INP…`);
            await sleep(interact * 1000);
        }

        const raw = await session.evaluate<string | undefined>(
            'JSON.stringify(window.__webviewLensVitals ?? null)',
        );
        const jsHeapMb = session.getMemoryUsageMb ? await session.getMemoryUsageMb() : null;

        return { vitals: JSON.parse(raw ?? 'null'), jsHeapMb };
    };

    const rows: LabRow[] = [];

    try {
        for (const pagePath of paths) {
            const results: LabRun[] = [];
            const heaps: (number | null)[] = [];

            for (let run = 1; run <= runs; run += 1) {
                const { vitals, jsHeapMb } = await measure(origin + pagePath);

                results.push(vitals ?? { lcp: null, fcp: null, cls: null, inp: null, ttfb: null });
                heaps.push(jsHeapMb);
                log(
                    `  ${pagePath} #${run}: LCP ${formatMetric('LCP', vitals?.lcp)}, CLS ${formatMetric('CLS', vitals?.cls)}`,
                );
            }

            const pick = (key: 'lcp' | 'fcp' | 'cls' | 'inp' | 'ttfb') =>
                median(results.map((r) => r[key]));
            const last = results.at(-1);
            const ltCount = median(results.map((r) => r.longTasksCount));
            const ltTotal = median(results.map((r) => r.longTasksTotalMs));
            const medianHeap = median(heaps);

            rows.push({
                path: pagePath,
                LCP: pick('lcp'),
                FCP: pick('fcp'),
                CLS: pick('cls'),
                INP: pick('inp'),
                TTFB: pick('ttfb'),
                lcpElement: last?.lcpElement ?? null,
                shifts: last?.shifts ?? [],
                ...(ltCount !== null || ltTotal !== null
                    ? {
                          longTasks: {
                              count: Math.round(ltCount ?? 0),
                              totalMs: Math.round(ltTotal ?? 0),
                          },
                      }
                    : {}),
                ...(last?.marks && Object.keys(last.marks).length > 0 ? { marks: last.marks } : {}),
                ...(medianHeap !== null ? { jsHeapMb: medianHeap } : {}),
            });
        }
    } finally {
        await session.setCacheDisabled(false).catch(() => undefined);
        if (throttle !== 'none' && session.setNetworkThrottle) {
            await session.setNetworkThrottle('none').catch(() => undefined);
        }
        if (cpu > 1 && session.setCpuThrottle) {
            await session.setCpuThrottle(1).catch(() => undefined);
        }
        session.close();
    }

    return {
        origin,
        device,
        capabilities: session.capabilities,
        options: { runs, cold, interact },
        rows,
    };
};

const ICON: Record<Rating | 'none', string> = {
    good: '🟢',
    'needs-improvement': '🟡',
    poor: '🔴',
    none: '⚪',
};

const isMetricUnsupported = (name: MetricName, capabilities?: InspectorCapabilities): boolean => {
    if (!capabilities) return false;
    if (name === 'LCP') return !capabilities.lcp;
    if (name === 'CLS') return !capabilities.cls;
    if (name === 'INP') return !capabilities.inp;

    return false;
};

/** Markdown report with ratings, WebKit `n/a` annotations, Long Tasks and custom marks. */
export const toMarkdown = (
    { origin, device, capabilities, options, rows }: LabResult,
    date = new Date(),
): string => {
    const cell = (name: MetricName, value: number | null) => {
        if (value === null && isMetricUnsupported(name, capabilities)) return `${ICON.none} n/a`;

        return `${ICON[rateOrNone(name, value) ?? 'none']} ${formatMetric(name, value)}`;
    };
    const hasLongTasks = rows.some((row) => row.longTasks !== undefined);
    const hasHeap = rows.some((row) => row.jsHeapMb !== undefined);
    const hasMarks = rows.some((row) => row.marks && Object.keys(row.marks).length > 0);
    const extraHeaders = [
        ...(hasLongTasks ? ['Long Tasks'] : []),
        ...(hasHeap ? ['JS Heap'] : []),
        ...(hasMarks ? ['Marks'] : []),
    ];

    const extraCells = (row: LabRow): string[] => [
        ...(hasLongTasks
            ? [row.longTasks ? `${row.longTasks.count} (${row.longTasks.totalMs} ms)` : '—']
            : []),
        ...(hasHeap ? [row.jsHeapMb !== undefined ? `${row.jsHeapMb.toFixed(1)} MB` : '—'] : []),
        ...(hasMarks
            ? [
                  row.marks && Object.keys(row.marks).length > 0
                      ? Object.entries(row.marks)
                            .map(([k, v]) => `${k}=${v} ms`)
                            .join(', ')
                      : '—',
              ]
            : []),
    ];

    return [
        '# Web Vitals in the WebView',
        '',
        `- When: ${date.toISOString()}`,
        `- What: ${origin}`,
        `- Device: ${device}`,
        `- Runs per screen: ${options.runs} (median), cache: ${options.cold ? 'disabled' : 'normal'}, INP: ${options.interact ? `taps for ${options.interact} s` : 'not measured'}`,
        '',
        `| Screen | ${METRIC_NAMES.join(' | ')} | LCP element | Shifts ≥ 0.01 |${extraHeaders.length ? ` ${extraHeaders.join(' | ')} |` : ''}`,
        `| --- | ${METRIC_NAMES.map(() => '---').join(' | ')} | --- | --- |${extraHeaders.length ? ` ${extraHeaders.map(() => '---').join(' | ')} |` : ''}`,
        ...rows.map((row) => {
            const tail = extraCells(row);

            return `| \`${row.path}\` | ${METRIC_NAMES.map((m) => cell(m, row[m])).join(' | ')} | ${row.lcpElement ?? '—'} | ${row.shifts.join(', ') || '—'} |${tail.length ? ` ${tail.join(' | ')} |` : ''}`;
        }),
        '',
        'web.dev thresholds: LCP ≤ 2.5 s, FCP ≤ 1.8 s, CLS ≤ 0.1, INP ≤ 200 ms, TTFB ≤ 0.8 s are 🟢; up to 4 s, 3 s, 0.25, 500 ms, 1.8 s are 🟡; above is 🔴.',
        '',
    ].join('\n');
};
