// Lab Web Vitals in CI from your own script: measure, save the report, fail the job on budgets.
// Run: node examples/recipes/ci-vitals.ts   (a phone with the app open, USB debugging on)

import fs from 'node:fs';

import {
    checkBudgets,
    measureVitals,
    parseBudgets,
    resolveDriver,
    toMarkdown,
} from '../../src/node/index.ts';
// #region demo-only
import { isMainModule } from '../rum/assets.ts';
// #endregion

export const runVitals = async () => {
    // 'auto' picks the connected platform; pass 'android' or 'ios' to pin it.
    const driver = await resolveDriver(process.env.PLATFORM === 'ios' ? 'ios' : 'auto');
    const result = await measureVitals({
        driver,
        paths: ['/', '/orders'],
        runs: 3,
        cold: true,
        // Progress and what blocks it ("No phone found: …") in the job log; the library is silent otherwise.
        log: console.log,
        // A job must not hang forever when the phone is not there.
        wait: { signal: AbortSignal.timeout(5 * 60_000) },
    });

    fs.writeFileSync('webview-vitals.md', toMarkdown(result));

    const violations = checkBudgets(result, parseBudgets('lcp=2500,cls=0.1,ttfb=800'));

    for (const v of violations) console.error(`✗ ${v.path} ${v.metric}: ${v.actual} > ${v.limit}`);
    process.exitCode = violations.length > 0 ? 1 : 0;
};
// #region demo-only

if (isMainModule(import.meta.url)) await runVitals();
// #endregion
