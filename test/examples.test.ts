import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { server } from '../examples/rum/server.ts';
import { renderExample } from '../scripts/sync-examples.ts';

describe('examples/rum demo server (the code shown in README)', () => {
    let base = '';

    before(async () => {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    it('accepts vitals, timings and client errors and exposes them on /metrics', async () => {
        const post = (path: string, body: unknown) =>
            fetch(base + path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });

        assert.equal(
            (
                await post('/api/vitals', {
                    name: 'LCP',
                    value: 1800,
                    rating: 'good',
                    path: '/event/:id',
                    context: { env: 'android-webview' },
                })
            ).status,
            204,
        );
        assert.equal(
            (await post('/api/timings', { name: 'bridge.init', duration: 42, path: '/' })).status,
            204,
        );
        assert.equal(
            (await post('/api/client-log', { message: 'boom', path: '/event/:id' })).status,
            204,
        );

        const metrics = await (await fetch(`${base}/metrics`)).text();

        assert.match(
            metrics,
            /webview_lens_vital_samples_total\{name="LCP",path="\/event\/:id",env="android-webview"\} 1/,
        );
        assert.match(metrics, /webview_lens_timing_quantile\{name="bridge.init"/);
        assert.match(metrics, /webview_lens_client_errors_total\{path="\/event\/:id"/);
    });

    it('serves the demo page and refuses paths outside dist/', async () => {
        const page = await fetch(`${base}/`);

        assert.equal(page.status, 200);
        assert.match(await page.text(), /importmap/);
        assert.equal((await fetch(`${base}/lib/%2e%2e/package.json`)).status, 404);
        assert.equal((await fetch(`${base}/nope`)).status, 404);
    });
});

describe('renderExample', () => {
    it('drops demo-only regions and maps src imports to package specifiers', () => {
        const rendered = renderExample(
            [
                "import { x } from '../../src/rum/server.ts';",
                '// #region demo-only',
                "import { y } from './assets.ts';",
                '// #endregion',
                '',
                'x();',
            ].join('\n'),
            'examples/rum/server.ts',
        );

        assert.equal(rendered, "import { x } from 'webview-lens/rum/server';\n\nx();\n");
    });
});
