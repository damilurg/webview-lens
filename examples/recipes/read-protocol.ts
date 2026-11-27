// Reading DevTools protocol results without casts: `send` and `on` hand out `unknown`, decoders turn
// it into the fields you read (or `undefined`, if the page, the phone or a proxy sent another shape).
// Run: node examples/recipes/read-protocol.ts

import {
    connectCdp,
    decodeCookies,
    decodeEvaluateResult,
    type Decoder,
    num,
    rec,
    sendDecoded,
    str,
    subscribe,
    waitForPage,
} from '../../src/node/index.ts';
// #region demo-only
import { isMainModule } from '../rum/assets.ts';
// #endregion

// Your own decoder for a command webview-lens does not cover.
const decodeLayout: Decoder<{ width: number; height: number }> = (input) => {
    const viewport = rec(rec(input)?.cssVisualViewport);
    const width = num(viewport?.clientWidth);
    const height = num(viewport?.clientHeight);

    return width !== undefined && height !== undefined ? { width, height } : undefined;
};

export const inspectPage = async (port = 9223) => {
    const page = await waitForPage(port, (p) => p.type === 'page' && p.url.startsWith('https://'));
    const cdp = await connectCdp(page.webSocketDebuggerUrl);

    // A result of another shape rejects with the method name instead of failing later on `undefined`.
    const cookies = await sendDecoded(
        cdp,
        'Network.getCookies',
        { urls: [page.url] },
        decodeCookies,
    );
    const layout = await sendDecoded(cdp, 'Page.getLayoutMetrics', {}, decodeLayout);
    const title = str(
        decodeEvaluateResult(
            await cdp.send('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            }),
        )?.value,
    );

    console.log({ title, cookies: cookies.map((c) => c.name), layout });

    // Events: the listener only sees params that decode.
    const off = subscribe(
        cdp,
        'Page.frameNavigated',
        (input) => str(rec(rec(input)?.frame)?.url),
        (url) => console.log('navigated to', url),
    );

    await cdp.send('Page.enable');
    await cdp.closed;
    off();
};

// #region demo-only

if (isMainModule(import.meta.url)) await inspectPage();
// #endregion
