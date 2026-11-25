// The page side of the `dev` WebSocket bridge (Android). CDP Fetch cannot intercept WebSockets, so
// sockets to the stand's bridged prefixes (and separate HMR ports) are replaced in the page by a stub
// that talks to webview-lens through a CDP binding: page → binding → Node → local server, and back
// through Runtime.evaluate on the receiver.

/** CDP binding the page calls to send socket events to webview-lens. */
export const BINDING = '__webviewLensWsSend';

/** Page function webview-lens calls to deliver socket events back to the page. */
export const RECEIVER = '__webviewLensWsRecv';

/** Page script replacing WebSocket for URLs under the bridged prefixes and separate HMR ports. */
export const bridgeShim = (
    remote: string,
    wsPrefixes: readonly string[],
    hmrPorts: readonly number[] = [],
): string => {
    const wsRemote = remote.replace(/\/+$/, '').replace(/^http/, 'ws');
    const hmrPrefixes = hmrPorts.flatMap((port) => [
        `ws://localhost:${port}`,
        `wss://localhost:${port}`,
        `ws://127.0.0.1:${port}`,
        `wss://127.0.0.1:${port}`,
    ]);
    const prefixes = [...wsPrefixes.map((prefix) => wsRemote + prefix), ...hmrPrefixes];

    return `(() => {
    const Native = window.WebSocket;
    const prefixes = ${JSON.stringify(prefixes)};
    const open = new Map();
    let next = 0;
    const b64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
    const post = (message) => ${BINDING}(JSON.stringify(message));
    class Bridged extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor(url, protocols) {
            super();
            this.url = String(url); this.readyState = 0; this.binaryType = 'blob';
            this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0;
            this.sid = ++next; open.set(this.sid, this);
            // Subprotocols must reach the local server: Vite only upgrades 'vite-hmr' / 'vite-ping'.
            const list = protocols == null ? [] : [].concat(protocols).map(String);
            post({ sid: this.sid, type: 'open', url: this.url.replace(/^ws/, 'http'), protocols: list });
        }
        send(data) {
            const binary = typeof data !== 'string';
            const go = (payload) => post({ sid: this.sid, type: 'send', data: payload, binary });
            if (!binary) { go(data); return; }
            if (data instanceof Blob) { data.arrayBuffer().then((b) => go(b64(b))); return; }
            go(b64(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
        }
        close() { this.readyState = 2; post({ sid: this.sid, type: 'close' }); }
        _emit(type, init) {
            const event = type === 'message' ? new MessageEvent('message', init) : type === 'close' ? new CloseEvent('close', { code: 1000 }) : new Event(type);
            this.dispatchEvent(event);
            this['on' + type]?.(event);
        }
    }
    window.${RECEIVER} = (sid, type, data, binary) => {
        const ws = open.get(sid);
        if (!ws) return;
        if (type === 'open') { ws.readyState = 1; ws.protocol = data || ''; ws._emit('open'); return; }
        if (type === 'message') {
            let payload = data;
            if (binary) { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); payload = ws.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]); }
            ws._emit('message', { data: payload });
            return;
        }
        if (type === 'error') { ws._emit('error'); return; }
        if (type === 'close') { ws.readyState = 3; open.delete(sid); ws._emit('close'); }
    };
    window.WebSocket = new Proxy(Native, {
        construct(target, args) { const url = String(args[0]); return prefixes.some((p) => url.startsWith(p)) ? new Bridged(args[0], args[1]) : new target(...args); },
    });
})();`;
};
