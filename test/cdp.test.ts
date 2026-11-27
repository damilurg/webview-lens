import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickPage } from '../src/node/cdp.ts';

describe('Android: several WebViews on the same URL', () => {
    it('works with the page on screen, not a WebView left below it', () => {
        const page = (id: string, attached: boolean) => ({
            id,
            type: 'page',
            url: 'https://stand.test/',
            title: '',
            webSocketDebuggerUrl: `ws://x/${id}`,
            description: JSON.stringify({ attached, visible: true }),
        });
        const pages = [page('below-1', false), page('on-screen', true), page('below-2', false)];

        assert.equal(pickPage(pages, (p) => p.type === 'page')?.id, 'on-screen');
        assert.equal(pickPage([page('only', false)], () => true)?.id, 'only');
        assert.equal(
            pickPage(null, () => true),
            undefined,
        );
    });
});
