import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWebKitTargetRouter } from '../src/node/drivers/ios/webkit-targets.ts';
import { sleep } from '../src/shared/utils.ts';

// Messages as iOS 26 WebKit sends them through ios_webkit_debug_proxy (captured on a real iPhone).
const frameCreated = JSON.stringify({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'frame-8589934593', type: 'frame' } },
});
const pageCreated = JSON.stringify({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'page-46', type: 'page' } },
});

const setup = (legacyAfterMs = 5000) => {
    const upstream: Record<string, unknown>[] = [];
    const delivered: string[] = [];
    const router = createWebKitTargetRouter({
        sendUpstream: (raw) => upstream.push(JSON.parse(raw) as Record<string, unknown>),
        deliver: (raw) => delivered.push(raw),
        legacyAfterMs,
    });

    return { router, upstream, delivered };
};

describe('WebKit target routing (iOS 12.2+)', () => {
    it('queues commands until the page target is announced, then wraps them', () => {
        const { router, upstream } = setup();
        const command = JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: '1' },
        });

        router.send(command);
        assert.equal(upstream.length, 0);

        router.onUpstream(frameCreated);
        router.onUpstream(pageCreated);
        assert.equal(router.targetId, 'page-46', 'the page target wins over the frame target');
        assert.equal(upstream.length, 1);
        assert.equal(upstream[0]?.method, 'Target.sendMessageToTarget');
        assert.deepEqual((upstream[0]?.params as { message: string }).message, command);

        router.send(command);
        assert.equal((upstream[1]?.params as { targetId: string }).targetId, 'page-46');
        router.dispose();
    });

    it('unwraps replies and events, and swallows the wrapper acknowledgements', () => {
        const { router, upstream, delivered } = setup();

        router.onUpstream(pageCreated);
        router.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: {} }));
        router.onUpstream(JSON.stringify({ id: upstream[0]?.id, result: {} }));
        const reply = '{"result":{"result":{"type":"number","value":47}},"id":7}';

        router.onUpstream(
            JSON.stringify({
                method: 'Target.dispatchMessageFromTarget',
                params: { targetId: 'page-46', message: reply },
            }),
        );
        assert.deepEqual(delivered, [reply]);
        router.dispose();
    });

    it('follows a committed provisional target after navigation', () => {
        const { router, upstream } = setup();

        router.onUpstream(pageCreated);
        router.onUpstream(
            JSON.stringify({
                method: 'Target.didCommitProvisionalTarget',
                params: { oldTargetId: 'page-46', newTargetId: 'page-51' },
            }),
        );
        router.send('{"id":2,"method":"Page.reload","params":{}}');
        assert.equal((upstream[0]?.params as { targetId: string }).targetId, 'page-51');
        router.dispose();
    });

    it('falls back to direct messages when no target is announced (iOS before 12.2)', async () => {
        const { router, upstream, delivered } = setup(20);
        const command = '{"id":1,"method":"Runtime.enable","params":{}}';

        router.send(command);
        await sleep(40);
        assert.deepEqual(upstream, [JSON.parse(command)]);
        router.onUpstream('{"id":1,"result":{}}');
        assert.deepEqual(delivered, ['{"id":1,"result":{}}']);
        router.dispose();
    });
});
