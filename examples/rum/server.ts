import http from 'node:http';

import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from '../../src/rum/server.ts';
// #region demo-only
import { isMainModule, serveDemoAsset } from './assets.ts';
// #endregion

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
    // #region demo-only
    if (serveDemoAsset(req, res)) return;
    // #endregion
    res.writeHead(404).end();
});
// #region demo-only

if (isMainModule(import.meta.url)) {
    const port = Number(process.env.PORT ?? 3000);

    server.listen(port, () => {
        console.log(
            `RUM demo: http://localhost:${port}/  ·  metrics: http://localhost:${port}/metrics`,
        );
    });
}
// #endregion
