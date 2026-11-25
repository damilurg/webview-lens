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
