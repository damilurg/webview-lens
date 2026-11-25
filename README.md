<div align="center">

# webview-lens

[![npm version](https://img.shields.io/npm/v/webview-lens?logo=npm&color=cb3837)](https://www.npmjs.com/package/webview-lens)
[![npm downloads](https://img.shields.io/npm/dm/webview-lens?logo=npm)](https://www.npmjs.com/package/webview-lens)
[![CI](https://github.com/damilurg/webview-lens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/damilurg/webview-lens/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/damilurg/webview-lens?logo=github)](https://github.com/damilurg/webview-lens/releases/latest)
[![npm provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=sigstore&logoColor=white)](https://www.npmjs.com/package/webview-lens#provenance)
<br>
[![node](https://img.shields.io/node/v/webview-lens?logo=nodedotjs&logoColor=white)](https://www.npmjs.com/package/webview-lens)
[![types](https://img.shields.io/npm/types/webview-lens?logo=typescript&logoColor=white)](https://www.npmjs.com/package/webview-lens)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/webview-lens?activeTab=dependencies)
[![platforms](https://img.shields.io/badge/WebView-Android%20%7C%20iOS-6f42c1)](https://github.com/damilurg/webview-lens/blob/main/docs/ios.md)
[![license](https://img.shields.io/npm/l/webview-lens)](https://github.com/damilurg/webview-lens/blob/main/LICENSE)

**[Website](https://damilurg.github.io/webview-lens/)** · [Docs](docs/how-it-works.md) · [iOS setup](docs/ios.md) · [SSR & SSG](docs/ssr.md) · [RUM guide](docs/rum.md) · [npm](https://www.npmjs.com/package/webview-lens) · [Changelog](CHANGELOG.md) · [Report a bug](https://github.com/damilurg/webview-lens/issues/new)

**English** | [Русский](docs/ru/README.md)

</div>

**Debug, override and measure the web page inside a native app.** `webview-lens` opens full
**Chrome DevTools for Android WebView and iOS WKWebView** at a fixed `http://localhost:3300`, from
**macOS, Windows or Linux**, including iOS debugging on Windows. It loads **your localhost dev server
inside the app** behind the real HTTPS origin, streams the WebView's `console.log` to your terminal,
measures **Core Web Vitals on a real phone** with CI budgets, and ships a zero-dependency **RUM +
Prometheus** toolkit for production. **Zero runtime dependencies.**

A page inside a native WebView differs from desktop Chrome/Safari: it runs with a native JS bridge,
app-managed cookies and User-Agent, custom themes/locales, and strict HTTPS policies. `webview-lens`
lets you run your local dev server (Vite, Next.js, Nuxt, SvelteKit, Angular, Webpack, or any HTTP
server) behind the real stand's HTTPS origin with zero changes to your frontend code.

**Works with any app that embeds a WebView:** native Android (Kotlin/Java) and iOS (Swift/Objective-C),
Capacitor, Cordova / Ionic, React Native WebView, Flutter `webview_flutter`, and in-app browsers of
super-apps, as long as the test build enables WebView debugging.

| Piece                     | What it does                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webview-lens init`       | Detects your bundler (`next`, `nuxt`, `sveltekit`, `angular`, `vite`, `webpack`) and creates `webview-lens.config.json`                                        |
| `webview-lens dev`        | Serves the stand's HTTPS origin from your local dev server (Android: CDP `Fetch`; iOS: selective HTTPS MITM) with HMR and `--logs`                             |
| `webview-lens devtools`   | Full Chrome DevTools at a **fixed** `http://localhost:3300` (survives app restarts; bridges iOS WIP ↔ CDP on Windows & macOS)                                  |
| `webview-lens cert`       | Generates a local X.509 v3 Root CA and prints a terminal QR code to install `.mobileconfig` on a test iPhone                                                   |
| `webview-lens vitals`     | Lab LCP, FCP, CLS, INP, TTFB, Long Tasks, JS Heap and marks from a real phone + `--throttle`, `--cpu`, and CI `--budget`                                       |
| `webview-lens doctor`     | Diagnoses everything blocking the connection (`adb`, `usbmuxd`, `ios_webkit_debug_proxy`, screen lock, debuggable WebViews)                                    |
| `webview-lens/rum`        | Browser client (0 `node:*` imports): Web Vitals, custom timings, global errors, `detectWebViewEnv`, context tags                                               |
| `webview-lens/rum/server` | Edge-safe Fetch API handlers (`Request → Response`), Express/Node `toNodeHandler`, bounded `createRumAggregator` (`p50`/`p75`/`p95`) and Prometheus `/metrics` |

## Requirements

| Component                        | Minimum                                                                                        | Notes                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Node.js for the CLI              | **22.4**                                                                                       | Tested in CI on **22, 24 and 26** (Linux, macOS, Windows). Node 20 is not supported: no global `WebSocket`, EOL.        |
| Node.js for contributing         | **22.18**                                                                                      | Tests run `.ts` files natively; `.nvmrc` pins 26.                                                                       |
| `webview-lens/rum` (in the page) | **Chrome / Android WebView 80**, **Safari / iOS 13.4**                                         | ES2020 syntax; your bundler can transpile it lower.                                                                     |
| `webview-lens/rum/server`        | any Fetch API runtime                                                                          | Node 18+, Edge, Bun, Deno, Cloudflare Workers.                                                                          |
| `adb`                            | Android platform-tools with `adb reverse`                                                      | Auto-detected from `ADB`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the Android SDK, `PATH` or `~/Downloads`.                 |
| Android                          | **5.0** (API 21)                                                                               | `adb reverse` (for `--hmr-port`) needs 5.0; the old `ps` of Android 5–7 is supported.                                   |
| Android System WebView / Chrome  | `devtools`: any debuggable WebView · `dev`: **80** · `vitals`: **77** (LCP, CLS), **96** (INP) | CDP `Fetch` (74+) and the injected WebSocket bridge (80+). Android 7+ gets WebView updates from Google Play.            |
| iOS                              | **16.4** with `webView.isInspectable = true`                                                   | Older iOS: only development builds run from Xcode are inspectable. `dev` (MITM) works on any iOS that trusts a user CA. |
| Computer                         | macOS, Windows 10/11, Linux                                                                    | iOS: macOS and Windows (Apple Devices or iTunes, `ios_webkit_debug_proxy`).                                             |
| Frontend                         | any framework or plain HTML                                                                    | Presets for Next.js, Nuxt, SvelteKit, Angular, Vite, Webpack.                                                           |

Node.js versions are tested in CI. The phone-side minimums follow from the protocol features and
browser APIs `webview-lens` uses.

**Setup on the phone:**

- **Android:** USB debugging enabled and a test build calling `WebView.setWebContentsDebuggingEnabled(true)`.
- **iOS (macOS & Windows):** a test build with `webView.isInspectable = true`, _Settings → Safari → Advanced → Web Inspector_ enabled. For `devtools`/`vitals`/`--logs`: `ios_webkit_debug_proxy` (auto-started) and Apple Devices / iTunes on Windows. See [docs/ios.md](docs/ios.md).

## Quick Start

```bash
npm i -D webview-lens
npx webview-lens init --remote https://stand.example.com
npx webview-lens doctor
npx webview-lens dev
```

Also mirrored to [GitHub Packages](https://github.com/damilurg/webview-lens/pkgs/npm/webview-lens) as `@damilurg/webview-lens` (needs `@damilurg:registry=https://npm.pkg.github.com` in `.npmrc` and a GitHub token with `read:packages`).

## Local Dev Server Inside the App

```bash
# Android (auto-detects Vite / Next.js / Webpack / Nuxt / Angular)
npx webview-lens dev http://localhost:5173 --cmd "npm run dev" --logs

# iOS (macOS or Windows — run `npx webview-lens cert` once on the test iPhone)
npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com --cmd "npm run dev" --logs
```

Key options (also configurable via `webview-lens.config.json` or `--config <file>`):

- `--platform auto|android|ios` selects the device driver (`auto` picks whichever phone is connected).
- `--preset auto|next|nuxt|sveltekit|angular|vite|webpack|generic` configures WebSocket HMR prefixes and quiet static logs.
- `--forwarded` sends `X-Forwarded-Host/Proto` for the stand to SSR servers, so absolute URLs, canonical tags and OAuth callbacks point at the stand. Works with SSR dev servers, production builds and static (SSG) output: see [docs/ssr.md](docs/ssr.md).
- `--remote <url>` sets the stand origin to override (default: the current WebView origin on Android; required on iOS).
- `--remote-base /shop` and `--local-base /` map a stand subpath to your local server root (rewriting URLs, `Referer`, and `Location`).
- `--ws <prefix>` bridges WebSockets under that prefix over CDP on Android (repeatable).
- `--hmr-port <n>` bridges separate local HMR ports (Vite/Webpack) over CDP and sets up `adb reverse` automatically.
- `--quiet <prefix>` hides noisy asset paths from logs; `--bypass <prefix>` forwards matching paths directly to the stand.
- `--sse fail|continue` prevents infinite `text/event-stream` responses from hanging CDP `Fetch`.
- `--logs` streams `console.*`, uncaught exceptions (1-based `path:line:col`), and 4xx/5xx or failed network requests to your terminal.
- `--serial <id>` (or `ANDROID_SERIAL`) selects a specific phone; `--app <package>` pins Android WebView discovery to a specific package.
- Press **Enter** to reload the page on Android. **Ctrl+C** exits and stops servers started with `--cmd`.

## DevTools at a Fixed Address

```bash
npx webview-lens devtools --logs
npx webview-lens devtools --platform ios --logs
```

Opens Chrome DevTools at `http://localhost:3300` without `devtools://` copy-pasting or broken page IDs after app restarts. On iOS, the built-in RFC 6455 WebSocket server translates WebKit Inspector Protocol (WIP) ↔ Chrome DevTools Protocol (CDP), so Chrome DevTools works identically on Windows and macOS. Set `DEVTOOLS_FRONTEND_ORIGIN` to use an internal mirror behind corporate VPNs.

## Lab Web Vitals & CI Budgets

```bash
npx webview-lens vitals / /events "/event/42" \
  --runs 3 --cold --throttle slow-4g --cpu 4 \
  --budget lcp=2500,cls=0.1 \
  --out reports/vitals.md
```

- Measures median **LCP** (with element), **FCP**, **CLS** (with shifts ≥ 0.01), **INP** (with `--interact <s>`), **TTFB**, **Long Tasks**, **JS Heap** (Android), and custom `performance.mark` entries.
- Exits with code `1` when any `--budget` threshold is exceeded — ready for CI and device farms.
- On iOS WKWebView, metrics unsupported by WebKit are honestly marked as `n/a`.
- Measure a production build (`npm run build && npm start`), not a dev server.

## Production RUM & Prometheus

### Browser (`webview-lens/rum`)

<!-- example: examples/rum/client.js -->

```js
import {
    captureGlobalErrors,
    createErrorReporter,
    createTimingReporter,
    createVitalsReporter,
    detectWebViewEnv,
} from 'webview-lens/rum';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

const context = () => ({ env: detectWebViewEnv(), release: '1.4.0' });
const report = createVitalsReporter({
    endpoint: '/api/vitals',
    path: () => '/event/:id', // supports both :param and [param]
    sampleRate: 1, // lower it in production, e.g. 0.5
    context,
});
[onCLS, onINP, onLCP, onFCP, onTTFB].forEach((on) => on(report));

export const reportTiming = createTimingReporter({ endpoint: '/api/timings', context });
captureGlobalErrors(createErrorReporter({ endpoint: '/api/client-log', context }));
```

<!-- /example -->

### Server (`webview-lens/rum/server`)

Works natively in Fetch API runtimes (Next.js App Router, Hono, Bun, Deno, Cloudflare Workers) and in Express / NestJS / `node:http` via `toNodeHandler`:

<!-- example: examples/rum/server.ts -->

```ts
import http from 'node:http';

import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from 'webview-lens/rum/server';

const rum = createRumAggregator({ maxSamplesPerSeries: 1000, maxSeries: 200 });

const routes: Record<string, ReturnType<typeof toNodeHandler>> = {
    '/api/vitals': toNodeHandler(createVitalsHandler({ onMetric: (m) => rum.recordVital(m) })),
    '/api/timings': toNodeHandler(createTimingsHandler({ onTiming: (t) => rum.recordTiming(t) })),
    '/api/client-log': toNodeHandler(createClientLogHandler({ onLog: (e) => rum.recordError(e) })),
    '/metrics': toNodeHandler(createMetricsHandler(rum)), // Prometheus 0.0.4
};

export const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? '/', 'http://localhost').pathname];

    if (route) return void route(req, res);
    res.writeHead(404).end();
});
```

<!-- /example -->

### Runnable demo

The two snippets above are [`examples/rum/client.js`](examples/rum/client.js) and [`examples/rum/server.ts`](examples/rum/server.ts), copied into this README by `npm run examples:sync` (CI fails when they drift). Run them end to end:

```bash
npm run demo:rum   # prints the URL (3000, or the next free port; PORT=… to pin it)
```

## Programmatic API & Benchmarks

All CLI building blocks are exported from `webview-lens` (`createAndroidDriver`, `createIosDriver`, `resolveDriver`, `startOverride`, `startIosMitmProxy`, `startDevtoolsLink`, `startIosDevtoolsLink`, `measureVitals`, `parseBudgets`, `checkBudgets`, `renderQrTerminal`, `loadProjectConfig`, and more).

Run unit/BDD/conformance tests and hot-path benchmarks:

```bash
npm run verify
npm run bench
```

## FAQ

### How do I debug an Android WebView without `chrome://inspect`?

Run `npx webview-lens devtools` and open `http://localhost:3300` in Chrome. It is the same Chrome
DevTools, but at an address that does not change when the app restarts (the `chrome://inspect` link
does), and it opens in a normal tab you can bookmark. The app's build must call
`WebView.setWebContentsDebuggingEnabled(true)`.

### How do I inspect an iOS WKWebView or Safari on Windows?

`webview-lens devtools --platform ios` works on Windows and macOS: it finds the iPhone over USB
(`usbmuxd`, from Apple Devices / iTunes), starts `ios_webkit_debug_proxy` and translates the WebKit
Inspector Protocol to Chrome DevTools, so you debug in Chrome at `http://localhost:3300`. The app must
set `webView.isInspectable = true` (iOS 16.4+). See [docs/ios.md](docs/ios.md).

### How do I load my localhost dev server inside a mobile app's WebView?

`npx webview-lens dev http://localhost:3000`. The WebView stays on the stand's HTTPS origin (no
`ERR_CLEARTEXT_NOT_PERMITTED`, no app changes) and every request to that origin is answered by your
local server, with HMR. Android uses Chrome DevTools Protocol `Fetch`; iOS uses a selective HTTPS
proxy that intercepts only your stand's host.

### How do I see a WebView's `console.log` and errors in the terminal?

Add `--logs` to `dev` or `devtools`: console messages, uncaught exceptions with source locations, and
failed or 4xx/5xx network requests are printed as they happen.

### How do I measure Core Web Vitals inside a WebView, and fail CI on regressions?

`npx webview-lens vitals / /catalog --runs 5 --budget lcp=2500,cls=0.1` measures LCP, FCP, CLS, INP,
TTFB, Long Tasks and JS heap on a real phone, writes a Markdown report, and exits with code 1 when a
budget is exceeded. `--throttle` and `--cpu` emulate slow networks and devices on Android.

### How do I monitor WebView performance in production?

Use `webview-lens/rum` in the page and `webview-lens/rum/server` on your server: Web Vitals, custom
timings and JS errors, segmented by `android-webview` / `ios-wkwebview` / `browser`, aggregated into
p50/p75/p95 and exported to Prometheus. See [docs/rum.md](docs/rum.md).

### Does it work with Capacitor, Cordova, Ionic, React Native or Flutter?

Yes: they all render in Android WebView and iOS WKWebView. The debug build has to allow WebView
debugging: Android enables it for debuggable builds, Capacitor has `webContentsDebuggingEnabled`,
React Native WebView has `webviewDebuggingEnabled`, and `webview_flutter` has
`AndroidWebViewController.enableDebugging(true)` and `WebKitWebViewController.setInspectable(true)`.

### Does it work with SSR and SSG (Next.js, Nuxt, SvelteKit, Angular)?

Yes, for dev servers, production builds and static output; `--forwarded` makes SSR servers build
absolute URLs for the stand. See [docs/ssr.md](docs/ssr.md).

## Alternatives

| Need                                        | `chrome://inspect` | Safari Web Inspector | `ios_webkit_debug_proxy` | Eruda / vConsole    | HTTP proxy (Charles, Proxyman) | `webview-lens` |
| ------------------------------------------- | ------------------ | -------------------- | ------------------------ | ------------------- | ------------------------------ | -------------- |
| Android WebView                             | ✓                  | —                    | —                        | ✓ (injected script) | network only                   | ✓              |
| iOS WKWebView                               | —                  | ✓                    | ✓                        | ✓ (injected script) | network only                   | ✓              |
| iOS debugging on Windows                    | —                  | —                    | ✓ (no UI of its own)     | ✓                   | network only                   | ✓              |
| Full Chrome DevTools at a fixed URL         | —                  | —                    | —                        | —                   | —                              | ✓              |
| Local dev server behind the stand's HTTPS   | —                  | —                    | —                        | —                   | ✓ (Map Remote)                 | ✓ (with HMR)   |
| WebView logs in the terminal                | —                  | —                    | —                        | —                   | —                              | ✓              |
| Lab Web Vitals on a real phone + CI budgets | manual             | manual               | —                        | —                   | —                              | ✓              |
| Production RUM + Prometheus                 | —                  | —                    | —                        | —                   | —                              | ✓              |

`webview-lens` builds on the same protocols: it uses `adb` and the WebView's DevTools socket on
Android, and `ios_webkit_debug_proxy` on iOS.

## Documentation

- Architecture: [docs/how-it-works.md](docs/how-it-works.md)
- iOS WKWebView setup (macOS & Windows): [docs/ios.md](docs/ios.md)
- SSR & SSG (Next.js, Nuxt, SvelteKit, Angular): [docs/ssr.md](docs/ssr.md)
- Production RUM & Prometheus guide: [docs/rum.md](docs/rum.md)
- ISO / RFC protocol conformance: [docs/standards.md](docs/standards.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)

## Limitations

- Test builds must enable WebView debugging (`WebView.setWebContentsDebuggingEnabled(true)` on Android; `webView.isInspectable = true` on iOS 16.4+) and disable SSL Pinning for iOS MITM override.
- iOS `WKWebView`: WebKit has no layout-shift entries, so `CLS` is `n/a`. `LCP` and Event Timing (for `INP`) need a recent iOS: LCP measured on iOS 26.6, older versions show `n/a`. `--throttle`, `--cpu`, and `JS Heap` are Android CDP-only.
- Lab INP counts only taps made during `--interact`.
- Production numbers come from RUM; lab numbers against a dev server are inflated.

## License

Copyright © 2026 [damilurg](https://github.com/damilurg) (`rootdamilurg@gmail.com`). Distributed under the [MIT License](LICENSE).
