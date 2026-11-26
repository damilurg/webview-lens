// The iPhone reaches the `dev` proxy over Wi-Fi, so this computer and the phone must be on one
// network. What goes wrong there (another Wi-Fi, a guest network that isolates devices, the
// computer's address changing) shows on the phone only as a page that never loads; these helpers
// turn it into a line in the terminal.

import os from 'node:os';

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** VPN and tunnel interfaces: the phone on the Wi-Fi cannot reach their addresses. */
const TUNNEL = /^(utun|ipsec|ppp|tun|tap|wg)/;
const LINK_LOCAL = /^169\.254\./;

/**
 * IPv4 addresses of this computer the phone can use, best first: a Wi-Fi or Ethernet address, then
 * tunnels (VPN), then link-local ones (169.254.x.x, a cable with no network behind it).
 */
export const detectLanAddresses = (interfaces: Interfaces = os.networkInterfaces()): string[] => {
    const ranked: { address: string; rank: number }[] = [];

    for (const [name, entries] of Object.entries(interfaces)) {
        for (const { family, internal, address } of entries ?? []) {
            if (family !== 'IPv4' || internal) continue;
            ranked.push({
                address,
                rank: LINK_LOCAL.test(address) ? 2 : TUNNEL.test(name) ? 1 : 0,
            });
        }
    }

    return ranked.sort((a, b) => a.rank - b.rank).map(({ address }) => address);
};

export interface NetworkWatchState {
    /** The address printed for "Configure Proxy → Server". */
    announced: string;
    port: number;
    /** Connections the proxy has seen from any client. */
    connections: number;
    /** Since the proxy started. */
    elapsedMs: number;
    /** The no-client hint was already printed. */
    hintedNoClient: boolean;
}

/** After this long without a single client, the phone is probably not reaching the computer. */
export const NO_CLIENT_AFTER_MS = 30_000;

/**
 * What to tell the user about the network now, and the state to keep. Pure: the CLI calls it on a
 * timer with the current addresses and the proxy's connection count.
 */
export const networkHints = (
    state: NetworkWatchState,
    currentAddresses: readonly string[],
): { lines: string[]; state: NetworkWatchState } => {
    const lines: string[] = [];
    let { announced, hintedNoClient } = state;
    const best = currentAddresses[0];

    if (!currentAddresses.includes(announced)) {
        if (best) {
            lines.push(
                `This computer's network address changed: ${announced} → ${best}. On the iPhone: ` +
                    `Settings → Wi-Fi → (i) → Configure Proxy → Server ${best}. A stand or dev server ` +
                    `with a certificate for ${announced} needs a new one.`,
            );
            announced = best;
        }
        if (!best && announced !== '') {
            lines.push(
                'This computer has no network address now (Wi-Fi off or disconnected): the iPhone cannot reach the proxy.',
            );
            announced = '';
        }
    }

    if (
        !hintedNoClient &&
        state.connections === 0 &&
        state.elapsedMs >= NO_CLIENT_AFTER_MS &&
        announced
    ) {
        lines.push(
            `No device has connected to the proxy at ${announced}:${state.port} in ${Math.round(state.elapsedMs / 1000)} s. ` +
                'If the app is open, the iPhone is not reaching this computer. Check: the same Wi-Fi as this ' +
                'computer (not cellular, not a guest or hotspot network that isolates devices); Configure ' +
                `Proxy → Manual, Server ${announced}, Port ${state.port}; no VPN on the phone. ` +
                'Safari on the iPhone: http://webview-lens.check/ shows "Proxy: OK" when it works.',
        );
        hintedNoClient = true;
    }

    return { lines, state: { ...state, announced, hintedNoClient } };
};

/** A private IPv4 host (10/8, 172.16/12, 192.168/16): an address on someone's local network. */
const isPrivateIpv4 = (host: string): boolean => {
    const parts = host.split('.').map(Number);

    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return false;
    }

    const [a = 0, b = 0] = parts;

    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

/**
 * `doctor` lines about the network: whether this computer has a local address for `dev`, and pages
 * in the app that point at a local IP which is not this computer any more (the app kept an old one).
 */
export const networkChecks = (
    addresses: readonly string[],
    targets: readonly { url: string }[],
): { ok: boolean; message: string }[] => {
    const usable = addresses.filter((address) => !LINK_LOCAL.test(address));
    const checks = [
        usable.length > 0
            ? {
                  ok: true,
                  message: `this computer on the local network: ${usable.join(', ')} (for \`dev\` the iPhone must be on the same Wi-Fi)`,
              }
            : {
                  ok: false,
                  message:
                      'no local network address on this computer: `dev` needs the iPhone and this computer on the same Wi-Fi (devtools and --logs work over USB alone)',
              },
    ];

    for (const { url } of targets) {
        let host: string;

        try {
            host = new URL(url).hostname;
        } catch {
            continue;
        }
        if (!isPrivateIpv4(host) || addresses.includes(host)) continue;
        checks.push({
            ok: false,
            message: `the page ${url} uses ${host}, which is not this computer (${usable.join(', ') || 'no address'}). If it should be served from here, the app has an old address.`,
        });
    }

    return checks;
};
