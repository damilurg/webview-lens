import assert from 'node:assert/strict';
import type os from 'node:os';
import { describe, it } from 'node:test';

import {
    detectLanAddresses,
    NO_CLIENT_AFTER_MS,
    networkChecks,
    type NetworkWatchState,
    networkHints,
} from '../src/node/drivers/ios/network.ts';

const v4 = (address: string, internal = false) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
});

describe('detectLanAddresses', () => {
    it('Wi-Fi first, then a VPN tunnel, then link-local; loopback and IPv6 left out', () => {
        const interfaces: ReturnType<typeof os.networkInterfaces> = {
            lo0: [v4('127.0.0.1', true)],
            en12: [v4('169.254.30.97')],
            utun4: [v4('10.128.176.239')],
            en0: [v4('192.168.86.130'), { ...v4('fe80::1'), family: 'IPv6', scopeid: 0 }],
        };

        assert.deepEqual(detectLanAddresses(interfaces), [
            '192.168.86.130',
            '10.128.176.239',
            '169.254.30.97',
        ]);
    });

    it('nothing but loopback: no address', () => {
        assert.deepEqual(detectLanAddresses({ lo0: [v4('127.0.0.1', true)] }), []);
    });
});

describe('networkHints (what the terminal says while iOS dev runs)', () => {
    const start: NetworkWatchState = {
        announced: '192.168.94.216',
        port: 8888,
        connections: 0,
        elapsedMs: 0,
        hintedNoClient: false,
    };

    it('silent while the address is the same and the phone is connected', () => {
        const { lines } = networkHints({ ...start, connections: 3, elapsedMs: 120_000 }, [
            '192.168.94.216',
        ]);

        assert.deepEqual(lines, []);
    });

    it('the address changed (the case met on the test iPhone): new Server to set, said once', () => {
        const first = networkHints({ ...start, connections: 5 }, ['192.168.86.130']);

        assert.equal(first.lines.length, 1);
        assert.match(first.lines[0] ?? '', /192\.168\.94\.216 → 192\.168\.86\.130/);
        assert.match(first.lines[0] ?? '', /Configure Proxy → Server 192\.168\.86\.130/);
        assert.equal(first.state.announced, '192.168.86.130');
        assert.deepEqual(networkHints(first.state, ['192.168.86.130']).lines, []);
    });

    it('the address is still there among others (a VPN came up): not a change', () => {
        assert.deepEqual(networkHints(start, ['10.0.0.5', '192.168.94.216']).lines, []);
    });

    it('no address at all: said once, then the new one when it comes back', () => {
        const gone = networkHints(start, []);

        assert.match(gone.lines[0] ?? '', /no network address/);
        assert.deepEqual(networkHints(gone.state, []).lines, []);
        assert.match(networkHints(gone.state, ['192.168.1.2']).lines[0] ?? '', /→ 192\.168\.1\.2/);
    });

    it('no client for 30 s: one hint with the address and port; not before, not again, not after a client', () => {
        const before = networkHints({ ...start, elapsedMs: NO_CLIENT_AFTER_MS - 1 }, [
            '192.168.94.216',
        ]);
        const at = networkHints({ ...start, elapsedMs: NO_CLIENT_AFTER_MS }, ['192.168.94.216']);
        const withClient = networkHints({ ...start, connections: 1, elapsedMs: 60_000 }, [
            '192.168.94.216',
        ]);

        assert.deepEqual(before.lines, []);
        assert.equal(at.lines.length, 1);
        assert.match(at.lines[0] ?? '', /192\.168\.94\.216:8888 in 30 s/);
        assert.match(at.lines[0] ?? '', /same Wi-Fi/);
        assert.deepEqual(
            networkHints({ ...at.state, elapsedMs: 90_000 }, ['192.168.94.216']).lines,
            [],
        );
        assert.deepEqual(withClient.lines, []);
    });
});

describe('networkChecks (doctor)', () => {
    it('the page points at the address this computer had before (the case met on the test iPhone)', () => {
        const checks = networkChecks(
            ['192.168.86.130'],
            [
                { url: 'https://192.168.94.216:8443/' },
                { url: 'https://192.168.86.130:8443/' },
                { url: 'https://stand.example.com/' },
                { url: 'about:blank' },
            ],
        );

        assert.deepEqual(
            checks.map(({ ok }) => ok),
            [true, false],
        );
        assert.match(
            checks[1]?.message ?? '',
            /uses 192\.168\.94\.216, which is not this computer \(192\.168\.86\.130\)/,
        );
    });

    it('only a link-local address: no usable network for dev', () => {
        const [check] = networkChecks(['169.254.30.97'], []);

        assert.equal(check?.ok, false);
        assert.match(check?.message ?? '', /no local network address/);
    });

    it('public and non-IP hosts, 172.32.x (not private) are not flagged; 10/8 and 172.16/12 are', () => {
        const flagged = (url: string) => networkChecks(['192.168.1.2'], [{ url }]).length > 1;

        assert.equal(flagged('https://8.8.8.8/'), false);
        assert.equal(flagged('https://172.32.0.1/'), false);
        assert.equal(flagged('https://localhost:5173/'), false);
        assert.equal(flagged('https://10.0.0.7/'), true);
        assert.equal(flagged('https://172.20.10.1/'), true);
        assert.equal(flagged('https://192.168.1.2/'), false);
    });
});
