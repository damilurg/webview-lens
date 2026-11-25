# Продакшен-RUM и экспорт в Prometheus

`webview-lens/rum` и `webview-lens/rum/server` дают лёгкий, Edge-safe транспорт, валидацию, ограниченный по памяти агрегатор перцентилей и экспортёр `/metrics` для Web Vitals, кастомных таймингов (например, инициализации нативного бриджа) и глобальных JS-ошибок.

## Подключение на клиенте (любой фронтенд-фреймворк)

```ts
import {
    captureGlobalErrors,
    createErrorReporter,
    createTimingReporter,
    createVitalsReporter,
    detectWebViewEnv,
} from 'webview-lens/rum';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

const context = () => ({
    env: detectWebViewEnv(), // 'android-webview' | 'ios-wkwebview' | 'browser'
    release: import.meta.env.VITE_RELEASE ?? 'dev',
});

const reportVital = createVitalsReporter({
    endpoint: '/api/vitals',
    path: () => '/event/:id', // поддерживаются шаблоны :param и [param]
    sampleRate: 0.5,
    context,
});
[onCLS, onINP, onLCP, onFCP, onTTFB].forEach((on) => on(reportVital));

export const reportTiming = createTimingReporter({
    endpoint: '/api/timings',
    context,
});

captureGlobalErrors(createErrorReporter({ endpoint: '/api/client-log', context }));
```

## Подключение на сервере

### Next.js App Router / Hono / Bun / Deno (Fetch API)

```ts
import { createVitalsHandler } from 'webview-lens/rum/server';

export const POST = createVitalsHandler({
    onMetric: ({ name, value, rating, path, context }) => {
        logger.info(`${name} ${rating} ${path}`, { value, env: context?.env });
    },
});
```

### Express / NestJS / `node:http` + встроенный агрегатор и Prometheus `/metrics`

```ts
import express from 'express';
import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from 'webview-lens/rum/server';

const app = express();
const rum = createRumAggregator({ maxSamplesPerSeries: 1000, maxSeries: 200 });

app.post(
    '/api/vitals',
    toNodeHandler(createVitalsHandler({ onMetric: (m) => rum.recordVital(m) })),
);
app.post(
    '/api/timings',
    toNodeHandler(createTimingsHandler({ onTiming: (t) => rum.recordTiming(t) })),
);
app.post(
    '/api/client-log',
    toNodeHandler(createClientLogHandler({ onLog: (e) => rum.recordError(e) })),
);
app.get('/metrics', toNodeHandler(createMetricsHandler(rum)));
```

Экспортируемые ряды (префикс по умолчанию `webview_lens`): `webview_lens_vital_samples_total` (counter), `webview_lens_vital_good_rate`, `webview_lens_vital_quantile` и `webview_lens_timing_quantile` (gauge с меткой `quantile`), `webview_lens_client_errors_total` (counter).

## Нюанс по iOS WKWebView

Safari/WKWebView поддерживает `TTFB`, `FCP`, Navigation/Resource Timing, кастомные тайминги (`createTimingReporter`) и сбор ошибок (`captureGlobalErrors`), но не отдаёт `CLS` и `INP` (а на старых версиях iOS — и `LCP`). Всегда сегментируйте дашборды по тегу `context.env` (`android-webview` vs `ios-wkwebview`).
