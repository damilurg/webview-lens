# Продакшен-RUM и экспорт в Prometheus

`webview-lens/rum` и `webview-lens/rum/server` дают лёгкий, Edge-safe транспорт, валидацию, ограниченный по памяти агрегатор перцентилей и экспортёр `/metrics` для Web Vitals, кастомных таймингов (например, инициализации нативного бриджа) и глобальных JS-ошибок.

## Подключение на клиенте (любой фронтенд-фреймворк)

<!-- example: examples/rum/client.js -->

```js
import {
    captureGlobalErrors,
    createErrorReporter,
    createTimingReporter,
    createVitalsReporter,
    detectWebViewEnv,
} from 'webview-lens/rum';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

const context = () => ({ env: detectWebViewEnv(), release: '1.4.0' });
const report = createVitalsReporter({
    endpoint: '/api/vitals',
    path: () => '/event/:id', // supports both :param and [param]
    sampleRate: 1, // lower it in production, e.g. 0.5
    context,
});
[onCLS, onINP, onLCP, onFCP, onTTFB].forEach((on) => on(report));

export const reportTiming = createTimingReporter({ endpoint: '/api/timings', context });
captureGlobalErrors(createErrorReporter({ endpoint: '/api/client-log', context }));
```

<!-- /example -->

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

### `node:http` + встроенный агрегатор и Prometheus `/metrics`

В Express и NestJS те же обработчики подключаются как есть: `app.post('/api/vitals', toNodeHandler(createVitalsHandler({ ... })))`.

<!-- example: examples/rum/server.ts -->

```ts
import http from 'node:http';

import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from 'webview-lens/rum/server';

const rum = createRumAggregator({ maxSamplesPerSeries: 1000, maxSeries: 200 });

const routes: Record<string, ReturnType<typeof toNodeHandler>> = {
    '/api/vitals': toNodeHandler(createVitalsHandler({ onMetric: (m) => rum.recordVital(m) })),
    '/api/timings': toNodeHandler(createTimingsHandler({ onTiming: (t) => rum.recordTiming(t) })),
    '/api/client-log': toNodeHandler(createClientLogHandler({ onLog: (e) => rum.recordError(e) })),
    '/metrics': toNodeHandler(createMetricsHandler(rum)), // Prometheus 0.0.4
};

export const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? '/', 'http://localhost').pathname];

    if (route) return void route(req, res);
    res.writeHead(404).end();
});
```

<!-- /example -->

Экспортируемые ряды (префикс по умолчанию `webview_lens`): `webview_lens_vital_samples_total` (counter), `webview_lens_vital_good_rate`, `webview_lens_vital_quantile` и `webview_lens_timing_quantile` (gauge с меткой `quantile`), `webview_lens_client_errors_total` (counter).

## Нюанс по iOS WKWebView

Safari/WKWebView поддерживает `TTFB`, `FCP`, Navigation/Resource Timing, кастомные тайминги (`createTimingReporter`) и сбор ошибок (`captureGlobalErrors`), но не отдаёт `CLS` и `INP` (а на старых версиях iOS — и `LCP`). Всегда сегментируйте дашборды по тегу `context.env` (`android-webview` vs `ios-wkwebview`).
