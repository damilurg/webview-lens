# How it works

```text
Android phone                              computer (macOS / Windows / Linux)
┌──────────────────────────────┐           ┌────────────────────────────────────────────┐
│ app → WebView (https://stand)│           │ webview-lens                               │
│   @webview_devtools_remote_<pid> ◄──adb──┤   ├─ dev:      Fetch.requestPaused → local │
└──────────────────────────────┘           │   ├─ devtools: localhost:3300 → frontend   │
                                           │   ├─ vitals:   PerformanceObserver + CI    │
iPhone (WKWebView)                         │   └─ --logs:   console / exceptions / HTTP │
┌──────────────────────────────┐           │                                            │
│ app → WKWebView              │◄──usbmux──┤   ├─ devtools: localhost:3300 (WIP ↔ CDP)  │
│   Wi-Fi HTTP Proxy ─────────────────────►│   └─ dev:      selective HTTPS MITM proxy  │
└──────────────────────────────┘           └────────────────────────────────────────────┘
```

## Finding the WebView (`src/node/adb.ts`, `src/node/device.ts`)

1. Every debuggable WebView opens the abstract unix socket `webview_devtools_remote_<pid>`. Those are listed with
   `adb shell cat /proc/net/unix`.
2. When several apps hold a WebView (for example a debug and a release build), the socket of the app on screen
   wins. That app comes from `dumpsys window` (`mFocusedApp`, then `mCurrentFocus`) and is matched against
   `ps -A -o PID,NAME`.
3. `adb forward tcp:9223 localabstract:<socket>`. After an app restart the pid changes, so whenever the port has no
   matching page, the forward is redone. Meanwhile the tool prints one line on what blocks it: no phone,
   unauthorized, locked screen (a locked WebView does not render), no WebView.

## Override (`src/node/override.ts`)

- `Fetch.enable` with `urlPattern: <remote>/*` pauses every request to the stand's origin. Each request is
  replayed against the local server with the stand's cookies (`Network.getCookies`), with `Origin` and `Referer`
  rewritten, and the result goes back through `Fetch.fulfillRequest`. `Location` headers are mapped back to the
  remote origin, and `Set-Cookie` headers pass through, so cookies land on the stand's domain.
- WebSockets are not covered by `Fetch`. `Page.addScriptToEvaluateOnNewDocument` installs a `WebSocket` proxy that,
  for the bridged prefixes, sends frames through `Runtime.addBinding`. This process opens the real socket to the
  local server and pushes frames back with `Runtime.evaluate`. Binary frames travel as base64.

## DevTools link (`src/node/devtools-link.ts`)

- `/` redirects to `/serve_rev/@<revision>/inspector.html?ws=localhost:3300/devtools/page/<id>`. The revision comes
  from the page's `devtoolsFrontendUrl` or from `WebKit-Version`, so the UI matches the WebView's Chromium.
- `/serve_rev/*` is fetched once from `chrome-devtools-frontend.appspot.com`, with the CSP `<meta>` removed, and kept
  in memory.
- `upgrade /devtools/*` is piped as raw TCP to the forwarded port, and the handshake is rewritten without
  `Origin`, which the debugging port rejects.

## Lab vitals (`src/node/vitals-lab.ts`)

A collector injected before the app's scripts records LCP (with its element), FCP, CLS (session windows,
gap < 1 s, window < 5 s, as in `web-vitals`), INP (longest interaction) and TTFB. Each screen is opened N times
with `Page.navigate`. The tool waits for `load` plus a settle time, reads the values and reports the medians.

## RUM (`src/rum`)

- The client sends one small JSON per metric with `sendBeacon`, which is still delivered when the WebView closes,
  the moment when CLS and INP become final. It falls back to `fetch(..., { keepalive: true })`.
- The server handlers use only the Fetch API (`Request`, `Response`, `ReadableStream`), so the same code runs in
  Next.js route handlers, edge runtimes, Bun, Deno and Node (`toNodeHandler`), and feed into a bounded in-memory
  aggregator (`src/rum/aggregator.ts`) with Prometheus `/metrics` export.

## iOS WKWebView (`src/node/drivers/ios/*`)

- **USB discovery (`usbmux.ts`)**: speaks the v1 XML plist framing protocol directly to `/var/run/usbmuxd` on macOS/Linux
  or `127.0.0.1:27015` (Apple Mobile Device Support) on Windows.
- **Inspector & DevTools (`iwdp.ts`, `wip-cdp-bridge.ts`, `devtools-bridge.ts`)**: discovers or auto-starts
  `ios_webkit_debug_proxy`, accepts Chrome DevTools WebSocket connections over an RFC 6455 codec (`src/node/ws-server.ts`),
  and translates CDP ↔ WebKit Inspector Protocol (WIP) bidirectionally.
- **Selective HTTPS MITM (`certs.ts`, `mitm-proxy.ts`)**: generates a local ECDSA P-256 X.509 v3 Root CA and per-host
  SAN leaf certificates with zero external binaries, serves an Apple `.mobileconfig` profile with a terminal QR code
  (`src/node/qr.ts`), and intercepts only the configured `--remote` hostname while passing all other traffic through raw TCP `CONNECT`.
