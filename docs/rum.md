# Production RUM Integration Guide

`webview-lens/rum` and `webview-lens/rum/server` provide a lightweight, zero-dependency transport and validation layer for Web Vitals, custom timings (e.g. native bridge init), and global JS errors.

## Client Setup (Any Frontend Framework)

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

## Server Setup

### Next.js App Router / Hono / Bun / Deno (Fetch API)

```ts
import { createTimingsHandler, createVitalsHandler } from 'webview-lens/rum/server';

export const POST = createVitalsHandler({
    onMetric: ({ name, value, rating, path, context }) => {
        // Forward to Prometheus, ClickHouse, OpenTelemetry, or structured logs
        prometheusHistogram.observe({ name, rating, path, env: context?.env ?? 'unknown' }, value);
    },
});
```

### Express / NestJS / `node:http`

```ts
import express from 'express';
import {
    createClientLogHandler,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from 'webview-lens/rum/server';

const app = express();

app.post('/api/vitals', toNodeHandler(createVitalsHandler({ onMetric: (m) => console.info(m) })));
app.post('/api/timings', toNodeHandler(createTimingsHandler({ onTiming: (t) => console.info(t) })));
app.post(
    '/api/client-log',
    toNodeHandler(createClientLogHandler({ onLog: (e) => console.error(e) })),
);
```

### Built-in Bounded Aggregator & Prometheus `/metrics` Endpoint

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

Exported series (default prefix `webview_lens`): `webview_lens_vital_samples_total` (counter), `webview_lens_vital_good_rate`, `webview_lens_vital_quantile` and `webview_lens_timing_quantile` (gauges with a `quantile` label), `webview_lens_client_errors_total` (counter).

## Note on iOS WKWebView Metrics

Safari/WKWebView supports `TTFB`, `FCP`, Navigation/Resource Timing, custom timings (`createTimingReporter`), and global error capture (`captureGlobalErrors`), while `CLS` and `INP` (and `LCP` on older iOS versions) are not emitted by WebKit. Always segment dashboards by `context.env` (`android-webview` vs `ios-wkwebview`).
