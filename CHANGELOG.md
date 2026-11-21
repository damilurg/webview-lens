# Changelog

All notable changes to `webview-lens` are documented in this file.

## [0.2.0] - 2026-11-24

### Added

- **Framework-agnostic `dev` override:** bundler presets (`--preset auto|next|vite|webpack|nuxt|angular|generic`), subpath mapping (`--remote-base` / `--local-base`), separate HMR port bridging (`--hmr-port` + auto `adb reverse`), `--quiet`, `--bypass`, and SSE non-blocking guard (`--sse fail|continue`).
- **Live device telemetry & multi-device:** `--logs` terminal streaming (`console.*`, uncaught exceptions with 1-based locations, 4xx/5xx & failed network requests), `--serial` / `ANDROID_SERIAL` selection, and `--app` package pinning.
- **Cross-platform iOS WKWebView support (macOS & Windows):** zero-dependency `usbmuxd` discovery, `ios_webkit_debug_proxy` lookup & auto-start (`ensureIwdp`), bidirectional WIP ↔ CDP translator, fixed-address Chrome DevTools UI (`http://localhost:3300`) with RFC 6455 WebSocket bridge, zero-dependency X.509 v3 Root CA / SAN leaf cert generator, `webview-lens cert` with UTF-8 terminal QR code, and selective HTTPS MITM `dev` proxy.
- **Project onboarding:** `webview-lens init` and `webview-lens.config.json` loader (`--config`) with CLI override precedence.
- **Performance & Production RUM:** CI budgets (`--budget`), Android network/CPU throttling (`--throttle`, `--cpu`), `JSHeapUsedSize`, Long Tasks & `performance.mark`, WebKit `n/a` reporting, RUM `:param` route templates, `toNodeHandler`, `detectWebViewEnv`, validated `context` tags, `createTimingReporter` / `createTimingsHandler`, bounded `createRumAggregator` (`p50`/`p75`/`p95`) and Prometheus `/metrics` (`toPrometheusText`, `createMetricsHandler`).
- **Quality & Standards:** zero-dependency hot-path benchmark suite (`npm run bench`), RFC 5280/5480/5758 / RFC 6455 / ISO/IEC 18004 / RFC 9110 conformance tests, and automated architectural invariants (`0 runtime deps`, early-return `0 else` in `src/`, Edge-safe `rum/`).

## [0.1.0] - Initial release

- Android WebView CDP override, fixed DevTools link, lab Web Vitals, and minimal RUM client/server handlers.
