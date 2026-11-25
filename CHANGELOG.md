# Changelog

All notable changes to `webview-lens` are documented in this file.

## [Unreleased]

Found by end-to-end runs on real phones: Redmi Note 8 Pro (Android 11, WebView 157) with a Kotlin and a Flutter app, and iPhone 17 Pro (iOS 26.6.1).

### Fixed

- **`dev` HMR for Vite-based stacks (Vite, Nuxt, SvelteKit, Angular):** the WebSocket bridge dropped the subprotocol the page asked for, and Vite only upgrades `vite-hmr` / `vite-ping` sockets, so HMR never connected. The subprotocols are now forwarded and the negotiated one is reported back to the page.
- `--logs`: an uncaught exception prints as `Error: message` with its stack instead of the object preview `{stack: …, message: …}`.
- `devtools` / `dev` / `vitals` print the `adb` path again (it was skipped when driver detection had already found adb).
- **iOS DevTools, `--logs` and `vitals` on iOS 12.2+ (every supported iOS):** WebKit page sockets only accept commands routed through its targets, so every command failed with "'Runtime' domain was not found". Commands now go through `Target.sendMessageToTarget` (the page target, followed across navigations) and replies are unwrapped from `Target.dispatchMessageFromTarget`, with a fallback to direct messages on older iOS.
- **iOS DevTools UI did not load:** the pinned Chrome DevTools frontend revision did not exist on appspot (404). It is now a verified revision and can be overridden with `WEBVIEW_LENS_DEVTOOLS_REVISION`.
- **`ios_webkit_debug_proxy` auto-start:** it was started with `-f`, which is `--frontend URL` and needs an argument, so the proxy exited at once. It now starts with its default ports; the hints in `doctor` say the same.
- **iOS `vitals` hung:** WebKit has no `Page.navigate`; navigation is now done in the page (`location.assign`). The CLI also passed the Android forward port (9223) to the iOS driver, which then looked for pages on the wrong port; `vitals` and `dev --logs` now start `ios_webkit_debug_proxy` like `devtools` does.
- **iOS CLS reported 🟢 0.000:** WebKit has no layout-shift entries, so CLS stayed at its initial 0. It is now `n/a` where layout shifts cannot be observed. The docs now say what iOS 26.6 measures: LCP and Event Timing yes, CLS no.
- An iPhone connected over USB and Wi-Fi at once is listed once.
- Chromium-only DevTools calls WebKit lacks (`Page.startScreencast`, `CSS.getEnvironmentVariables`, `CSS.getLonghandProperties`, computed-style tracking) are answered with empty results instead of errors.

## [0.3.4] - 2026-11-25

### Added

- Documentation website on GitHub Pages: <https://damilurg.github.io/webview-lens/> (English and Russian, search, Mermaid diagrams, sitemap, per-page canonical and Open Graph tags). Built with VitePress from `README.md`, `docs/` and this changelog by `site/build-content.ts`, deployed by `.github/workflows/pages.yml`.
- `homepage` points to the website.
- Website SEO: `hreflang` links between English and Russian pages, Open Graph image (1200×630, `summary_large_image`), `og:locale`, schema.org `SoftwareApplication` JSON-LD on the home pages, and "Last updated" dates from git history that also feed `lastmod` in `sitemap.xml`.

## [0.3.3] - 2026-11-25

### Fixed

- The npm package page shows the English README again. npm 11 (used since releases moved to Node.js 26) picked `README.ru.md` from the package root, so the Russian README moved to [`docs/ru/README.md`](docs/ru/README.md).

## [0.3.2] - 2026-11-25

### Added

- Requirements table in the README: minimum Node.js, `adb`, Android, Android System WebView, iOS, host OS and browser versions.
- FAQ and comparison with `chrome://inspect`, Safari Web Inspector, `ios_webkit_debug_proxy`, Eruda/vConsole and HTTP proxies; `llms.txt` for AI assistants; search-focused npm description and keywords.

### Changed

- CI tests Node.js 22, 24 and 26; releases are built on Node.js 26. Type definitions follow the minimum supported Node.js (`@types/node` 22), so APIs newer than Node 22 fail the type check.
- `devEngines` requires Node.js 22.18+ for contributing (native `.ts` tests); `.nvmrc` pins 26.

### Fixed

- Android 5–7: the toolbox `ps` (no `-A -o`) is parsed by its header, with a fallback to plain `ps`, so the WebView of the app on screen is found on old phones too.

## [0.3.1] - 2026-11-25

### Added

- Releases are mirrored to GitHub Packages as `@damilurg/webview-lens`; npmjs.com stays the canonical registry.

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
