import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { waitForOtherPageOnScreen } from '../src/node/device.ts';

describe('dev follows the WebView on screen', () => {
    it('resolves when another matching WebView is on screen and the held one is not', async () => {
        const page = (id: string, attached: boolean) => ({
            id,
            type: 'page',
            url: 'https://stand.test/',
            title: '',
            webSocketDebuggerUrl: `ws://x/${id}`,
            description: JSON.stringify({ attached, visible: true }),
        });
        let screens = [[page('held', true), page('other', false)]];
        const listPages = async () =>
            screens.shift() ?? [page('held', false), page('rotated', true)];

        const next = await waitForOtherPageOnScreen(9223, 'held', (p) => p.type === 'page', {
            intervalMs: 1,
            listPages,
        });

        assert.equal(next.id, 'rotated');
        screens = [];
    });

    it('stops when aborted', async () => {
        const watch = new AbortController();
        const pending = waitForOtherPageOnScreen(9223, 'held', () => true, {
            intervalMs: 1,
            listPages: async () => [],
            signal: watch.signal,
        });

        watch.abort();
        await assert.rejects(pending);
    });
});
