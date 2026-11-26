// `webview-lens vitals`: lab Web Vitals from the phone, a Markdown report and CI budgets.

import fs from 'node:fs';
import path from 'node:path';

import { fromGitBashPath } from '../../node/paths.ts';
import {
    checkBudgets,
    formatMetric,
    measureVitals,
    parseBudgets,
    toMarkdown,
} from '../../node/vitals-lab.ts';
import { METRIC_NAMES } from '../../shared/thresholds.ts';
import type { CliContext } from '../context.ts';
import { ensureIosProxy, logAdbPath } from '../runtime.ts';
import { terminal } from '../output.ts';
import { isHttpUrl } from '../../shared/utils.ts';

export const vitals = async (ctx: CliContext): Promise<void> => {
    const { cfg, values } = ctx;
    const throttle = cfg.throttle ?? 'none';
    const cpu = cfg.cpu ?? 1;

    if (!Number.isFinite(cpu) || cpu < 1) {
        throw new Error(`Invalid --cpu "${cpu}". Expected a number >= 1`);
    }

    const budgets = cfg.budget ? parseBudgets(cfg.budget) : undefined;
    const paths = ctx.args.length > 0 ? ctx.args.map(fromGitBashPath) : ['/'];
    const notPath = paths.find((pagePath) => !pagePath.startsWith('/'));

    // Paths are measured on the origin of the page the app has open.
    if (notPath !== undefined) {
        throw new Error(
            `vitals takes paths such as / or /orders, not "${notPath}". The origin is the page the app has open.`,
        );
    }
    const driver = await ctx.selectDriver();
    const devtoolsPort = ctx.portFor(driver.platform);

    if (driver.platform === 'android') logAdbPath();
    if (driver.platform === 'ios') await ensureIosProxy();

    const result = await measureVitals({
        driver,
        log: terminal.line,
        ...(devtoolsPort ? { devtoolsPort } : {}),
        paths,
        runs: Number(values.runs),
        cold: values.cold,
        interact: Number(values.interact),
        throttle,
        cpu,
        wait: ctx.targetOptions,
        isTarget: (page) =>
            page.type === 'page' &&
            isHttpUrl(page.url) &&
            (!cfg.match || page.url.includes(cfg.match)),
    });

    terminal.table(
        Object.fromEntries(
            result.rows.map((row) => [
                row.path,
                Object.fromEntries(METRIC_NAMES.map((m) => [m, formatMetric(m, row[m])])),
            ]),
        ),
    );

    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    fs.writeFileSync(values.out, toMarkdown(result));
    terminal.line(`Report: ${path.resolve(values.out)}`);

    if (!budgets) return;

    const violations = checkBudgets(result, budgets);

    if (violations.length === 0) {
        terminal.line('✓ All performance budgets passed');

        return;
    }

    terminal.error('Performance budget exceeded:');
    for (const v of violations) {
        terminal.error(
            `  ✗ ${v.path} ${v.metric}: ${formatMetric(v.metric, v.actual)} > ${formatMetric(v.metric, v.limit)}`,
        );
    }
    process.exitCode = 1;
};
