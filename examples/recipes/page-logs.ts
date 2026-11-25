// The WebView page's console, exceptions and failed requests as JSON lines for your own tooling
// (log collector, test reporter), instead of `--logs` text in the terminal. Android shown here.
// Run: node examples/recipes/page-logs.ts

import { attachTelemetry, connectCdp, waitForPage } from '../../src/node/index.ts';
// #region demo-only
import { isMainModule } from '../rum/assets.ts';
// #endregion

export const streamPageLogs = async (port = 9223) => {
    // Forwards the port to the app's WebView socket and waits until its page shows up.
    const page = await waitForPage(port, (p) => p.type === 'page' && p.url.startsWith('https://'));
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    const line = (kind: string) => (text: string) =>
        process.stdout.write(`${JSON.stringify({ kind, page: page.url, text })}\n`);

    attachTelemetry(cdp, {
        log: line('log'),
        error: line('error'),
        levels: ['log', 'warn', 'error'],
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.closed;
};
// #region demo-only

if (isMainModule(import.meta.url)) await streamPageLogs();
// #endregion
