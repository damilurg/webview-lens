# Changelog

All notable changes to `webview-lens` are documented in this file.

## [0.3.0] - 2026-11-25

### Added

- **SSR & SSG guide** ([docs/ssr.md](docs/ssr.md), [RU](docs/ru/ssr.md)): request flow, dev / production / static modes and RUM wiring for Next.js, Nuxt, SvelteKit and Angular.
- `dev --forwarded` (config `"forwarded": true`): reverse-proxy mode for SSR servers with `X-Forwarded-Host/Proto/Port`, `Forwarded` and `X-Forwarded-Prefix`, keeping the stand's Origin/Referer (Android and iOS).
- `sveltekit` preset, detected from `@sveltejs/kit`.
- RUM handlers: `allowOrigin` for cross-origin reporting from SSG sites (CORS headers and `OPTIONS` preflight); `corsHeaders` helper.
- RUM client: `isServerRuntime` and `isCrossOriginEndpoint`.

### Changed

- RUM client is SSR-safe: `beaconTransport` and the reporters are no-ops on the server, and `captureGlobalErrors` without a target returns a no-op instead of throwing `ReferenceError: window`.
- Cross-origin beacons are sent as `text/plain` (CORS-safelisted, no preflight).

## [0.2.1] - 2026-11-25

### Changed

- README: npm, CI, release, provenance, Node, types, dependencies, platform and license badges, plus quick links to the docs, npm, changelog and issue tracker.
- CI: `actions/checkout` and `actions/setup-node` updated to v7 (Node 24 runtime); the release workflow publishes without a dependency cache and without persisted git credentials.

## [0.2.0] - 2026-11-25

### Added

- **Framework-agnostic `dev` override:** bundler presets (`--preset auto|next|vite|webpack|nuxt|angular|generic`), subpath mapping (`--remote-base` / `--local-base`), separate HMR port bridging (`--hmr-port` + auto `adb reverse`), `--quiet`, `--bypass`, and SSE non-blocking guard (`--sse fail|continue`).
- **Live device telemetry & multi-device:** `--logs` terminal streaming (`console.*`, uncaught exceptions with 1-based locations, 4xx/5xx & failed network requests), `--serial` / `ANDROID_SERIAL` selection, and `--app` package pinning.
- **Cross-platform iOS WKWebView support (macOS & Windows):** zero-dependency `usbmuxd` discovery, `ios_webkit_debug_proxy` lookup & auto-start (`ensureIwdp`), bidirectional WIP ↔ CDP translator, fixed-address Chrome DevTools UI (`http://localhost:3300`) with RFC 6455 WebSocket bridge, zero-dependency X.509 v3 Root CA / SAN leaf cert generator, `webview-lens cert` with UTF-8 terminal QR code, and selective HTTPS MITM `dev` proxy.
- **Project onboarding:** `webview-lens init` and `webview-lens.config.json` loader (`--config`) with CLI override precedence.
- **Performance & Production RUM:** CI budgets (`--budget`), Android network/CPU throttling (`--throttle`, `--cpu`), `JSHeapUsedSize`, Long Tasks & `performance.mark`, WebKit `n/a` reporting, RUM `:param` route templates, `toNodeHandler`, `detectWebViewEnv`, validated `context` tags, `createTimingReporter` / `createTimingsHandler`, bounded `createRumAggregator` (`p50`/`p75`/`p95`) and Prometheus `/metrics` (`toPrometheusText`, `createMetricsHandler`).
- **Quality & Standards:** zero-dependency hot-path benchmark suite (`npm run bench`), RFC 5280/5480/5758 / RFC 6455 / ISO/IEC 18004 / RFC 9110 conformance tests, and automated architectural invariants (`0 runtime deps`, early-return `0 else` in `src/`, Edge-safe `rum/`).

### Security & robustness

- The iOS MITM proxy serves only loopback, private, link-local and CGNAT clients by default (`allowClient` option), so it is no longer an open proxy on a public interface.
- CLI flags go through the same validation as `webview-lens.config.json`; invalid flags, `--runs`, `--interact` and `--remote` fail with a one-line error instead of a stack trace.
- iOS MITM proxy: plain `http://` requests from the iPhone are forwarded instead of answered with the CA landing page; `close()` no longer hangs on keep-alive sockets; WebSocket HMR works with an `https://` local dev server.
- iOS DevTools bridge: the reply to the bridge's own `Console.enable` no longer reaches Chrome DevTools; client buffering is capped; console events carry CDP `timestamp` and the main-world `executionContextId`.
- `dev` WebSocket bridge: malformed binding payloads are ignored, and the page can only open sockets to the stand origin and configured HMR ports.
- CDP client: malformed frames or a throwing listener no longer crash the process; `/json/*` probes and the local server probe time out after 5 s.
- `toNodeHandler` answers 500 instead of an unhandled rejection when the callback throws or the `Host` header is malformed.

## [0.1.0] - Initial release

- Android WebView CDP override, fixed DevTools link, lab Web Vitals, and minimal RUM client/server handlers.
