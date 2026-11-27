import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InspectableTarget } from '../src/node/drivers/types.ts';
import { findVisibleTarget, waitForVisibleTarget } from '../src/node/drivers/visible-target.ts';

const target = (id: string, url = 'https://stand.test/'): InspectableTarget => ({
    id,
    platform: 'ios',
    type: 'page',
    url,
    title: id,
    debuggerUrl: `ws://localhost:9222/devtools/page/${id}`,
});

/** A driver whose pages answer `document.visibilityState`; `hidden` ones never answer (iOS). */
const driverWith = (pages: InspectableTarget[], visible: string, hidden: string[] = []) => {
    const probed: string[] = [];

    return {
        probed,
        listTargets: async () => pages,
        waitForTarget: async () => {
            const [first] = pages;

            if (!first) throw new Error('no page');

            return first;
        },
        connectInspector: async (t: InspectableTarget) => {
            probed.push(t.id);

            return {
                evaluate: () =>
                    hidden.includes(t.id)
                        ? new Promise<unknown>(() => undefined)
                        : Promise.resolve(t.id === visible ? 'visible' : 'hidden'),
                close: () => undefined,
            } as never;
        },
    };
};

describe('findVisibleTarget / waitForVisibleTarget (two WebViews of one app, seen on the iPhone)', () => {
    it('picks the page on screen, not the first match that is suspended behind another screen', async () => {
        const driver = driverWith([target('1'), target('2')], '2', ['1']);

        assert.equal((await waitForVisibleTarget(driver, () => true))?.id, '2');
    });

    it('one match: that one, without connecting to it (iOS allows one inspector per page)', async () => {
        const driver = driverWith([target('1'), target('x', 'about:blank')], '1');

        assert.equal((await findVisibleTarget(driver, (t) => t.url.startsWith('https')))?.id, '1');
        assert.deepEqual(driver.probed, []);
    });

    it('none visible: the first match; no match: undefined', async () => {
        const driver = driverWith([target('1'), target('2')], 'none');

        assert.equal((await findVisibleTarget(driver, () => true))?.id, '1');
        assert.equal(await findVisibleTarget(driver, () => false), undefined);
    });
});
