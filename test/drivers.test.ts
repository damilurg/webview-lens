import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Cdp } from '../src/node/cdp.ts';
import { createCdpInspectorSession } from '../src/node/drivers/android.ts';
import { resolveDriver } from '../src/node/drivers/registry.ts';
import { type DeviceDriver, isPlatformSelection } from '../src/node/drivers/types.ts';

describe('isPlatformSelection', () => {
    it('accepts auto, android, ios and rejects unknown values', () => {
        assert.equal(isPlatformSelection('auto'), true);
        assert.equal(isPlatformSelection('android'), true);
        assert.equal(isPlatformSelection('ios'), true);
        assert.equal(isPlatformSelection('windows-phone'), false);
    });
});

describe('resolveDriver', () => {
    const stubDriver = (platform: 'android' | 'ios', available: boolean): DeviceDriver => ({
        platform,
        isAvailable: () => available,
        listDevices: () => [],
        diagnose: async () => '',
        doctor: async () => ({ platform, checks: [], targets: [] }),
        listTargets: async () => null,
        waitForTarget: async () => {
            throw new Error('not implemented');
        },
        getDeviceDescription: async () => platform,
        connectInspector: async () => {
            throw new Error('not implemented');
        },
    });

    it('falls back to the first driver when none are connected under auto', async () => {
        const android = stubDriver('android', false);
        const ios = stubDriver('ios', false);

        assert.equal((await resolveDriver('auto', [android, ios])).platform, 'android');
    });

    it('throws a helpful error when an unregistered platform is requested explicitly', async () => {
        const android = stubDriver('android', true);

        await assert.rejects(
            () => resolveDriver('ios', [android]),
            /Platform "ios" is not available/,
        );
    });
});

describe('createCdpInspectorSession', () => {
    it('registers Page.loadEventFired before Page.navigate when waitForLoad is true', async () => {
        const order: string[] = [];
        let triggerLoad!: () => void;
        const cdp: Cdp = {
            send: async <T>(method: string) => {
                order.push(`send:${method}`);
                if (method === 'Page.navigate') triggerLoad();

                return {} as T;
            },
            on: () => () => undefined,
            once: <T>(method: string) => {
                order.push(`once:${method}`);

                return new Promise<T>((resolve) => {
                    triggerLoad = () => resolve({} as T);
                });
            },
            close: () => undefined,
            closed: new Promise(() => undefined),
        };

        const session = createCdpInspectorSession(cdp);

        await session.navigate('https://stand.example.test/about', { waitForLoad: true });

        assert.deepEqual(order, ['once:Page.loadEventFired', 'send:Page.navigate']);
    });
});
