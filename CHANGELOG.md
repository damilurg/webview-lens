# Changelog

All notable changes to `webview-lens` are documented in this file.

## [Unreleased]

Found by end-to-end runs on real phones: Redmi Note 8 Pro (Android 11, WebView 157) with a Kotlin and a Flutter app, and iPhone 17 Pro (iOS 26.6.1).

### Added

- Documentation site: a plain look (system fonts, neutral colours, no hero), a problem-first introduction, "WebView problems and fixes" and "Alternatives" pages (the README FAQ and comparison moved there), FAQ structured data, IndexNow pings after each deploy, and search console verification tags from repository variables.
- **`webview-lens keyboard`:** live keyboard and viewport numbers of the WebView page on Android and iOS: keyboard height, how much of the page it covers, the visible height, whether the focused field is visible, partly hidden or hidden (and whether a fixed bar is the reason), and the `--wl-*` values. `--overlay` draws them on the phone, `--frames` prints every animation frame. It follows the app to the visible WebView when an earlier screen keeps its own.
- `docs/verification.md`: every claim with how it was checked on the phones, the measurements, what was found and fixed, and what is not verified.
- **`webview-lens/viewport`:** keyboard and viewport helpers for pages in Android WebView and iOS WKWebView. `watchViewport()` keeps `--wl-keyboard-inset` (how much of the page the keyboard covers: the keyboard height on iOS, 0 where the WebView resized), `--wl-keyboard-height`, `--wl-viewport-height` and `data-wl-keyboard` up to date; `keepFocusedInputVisible()` scrolls a field the keyboard covers into view. Zero dependencies, SSR-safe; checked on Android 11 with the keyboard open.
- **Library logger:** `--verbose` (or `WEBVIEW_LENS_DEBUG=1`) shows what webview-lens itself does — adb calls with timings, port forwards, CDP sockets, WebKit target switches, proxy decisions — on stderr; `--log-file` (or `WEBVIEW_LENS_LOG_FILE`) writes JSON Lines for bug reports. `configureLogging` / `createLogger` for your own sinks.
- **Docs:** Getting started (install, debuggable WebView per stack, Android and iOS step by step, environment variables, config), Recipes (keyboard, iOS input zoom, safe areas, native sign-in cookies, one JS bridge API, back button, Android file upload, debug CA), runnable recipes in `examples/recipes/` copied into the docs, `ARCHITECTURE.md` and `CONTRIBUTING.md`; all on the website.
- Public API: `pickPage`, `isPageOnScreen`, `connectWebKitInspector`, `createWebKitTargetRouter`, `TransportAdapter`.

### Changed

- Every regular expression in `src` is tested as written there (read from the source with the TypeScript compiler): 286 positive, negative and edge cases for 43 regexes, a mutation check (anchors, flags, quantifiers and character classes changed) that every case set must catch, and a guard that a new or changed regex fails until it has cases. Repeated regexes became named helpers (`stripTrailingSlashes`, `isHttpUrl`, `toWebSocketUrl`, `unbracketHost`); `isHttpUrl` now accepts upper-case schemes.
- Stricter type checking: `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`. JSON is parsed in one place (`readJson` / `parseJson` in `src/shared/decode.ts`, always `unknown`), options objects are destructured, and no helper is defined twice; tests on the TypeScript AST enforce all three.
- Output is centralised: the CLI prints only through `src/cli/output.ts`; library functions (`measureVitals`, `startOverride`, `attachTelemetry`, `waitForPage`, `ensureServer`, the iOS proxy and DevTools links…) no longer write to the console by default: their `log` callbacks default to the library logger (silent until `--verbose` or `configureLogging`). Pass `log` / `logger` to show their output. A listener that throws inside the CDP client becomes a Node warning. A test on the TypeScript AST keeps `console` out of the rest of `src`.
- Type checking is split by runtime: Node code against Node's types without the DOM, the browser modules (`webview-lens/rum`, `webview-lens/viewport`, `src/shared`) against the DOM without Node types. `npm run check` is `tsc -b`, and the package builds in two passes. The pure part of the RUM client moved to `src/rum/context.ts`; `webview-lens/rum` re-exports it unchanged.
- The CDP client takes a `TransportAdapter` instead of knowing about iOS; WebKit target routing is one adapter.
- The CLI is split into one module per command over a validated `CliContext`; the WebSocket bridge shim and the proxy's pages have their own modules. No behaviour change.
- Harmless failures go through an explicit `bestEffort()` with the reason in a comment; iOS domain enables ignore only "method not found" (`enableIfSupported`).
- Benchmarks for WebKit target routing and on-screen page picking.

### Changed

- **Breaking (programmatic API):** `Cdp.send()`, `Cdp.on()`, `Cdp.once()` and `InspectorSession.evaluate()` return `unknown` instead of taking a type parameter that only claimed the shape. Decode results with the exported `sendDecoded`, `subscribe` and decoders (`decodeCookies`, `decodeEvaluateResult`, `rec`, `str`, `num`, …); see the recipe "Reading protocol results without casts".
- The library source has no type assertions (`as T`, `<T>x`, non-null `!`), checked by a test on the TypeScript AST. Protocol frames, the bridge shim's messages, lab vitals and CLI flags are decoded field by field; a frame of another shape is skipped instead of failing later on `undefined`.

### Fixed

- `webview-lens/viewport` on iOS, all found with `webview-lens keyboard` in a Flutter app on an iPhone and checked there with screenshots: `keepFocusedInputVisible` now detects whether client coordinates follow the visual viewport (they do in WKWebView in an app, so a hidden field looked visible), scrolls by a computed distance into the band above the keyboard and any fixed bar instead of `scrollIntoView` (which centres in the layout viewport), and re-checks once iOS stops panning; the layout height comes from the root `clientHeight` (`innerHeight` shrank 34 px while a fixed bar's field was focused); `--wl-keyboard-height` no longer drops while the visual viewport pans. New `--wl-scroll-room`: room to add at the end of the page so its last fields can scroll above the keyboard. The Flutter recipe now turns off the resize and the automatic content insets on iOS.
- `webview-lens/viewport`, found with `webview-lens keyboard` on an iPhone (Flutter): `--wl-keyboard-height` stayed 17 px too high after the WebView got shorter (the baseline now resets while no field is focused); iOS overscroll added its negative `offsetTop` to the keyboard height; `keepFocusedInputVisible` counted a field as visible while a fixed bar on the keyboard (a composer) covered it, and now keeps it above fixed and sticky bars.
- The iOS waiting hint names the usual cause first (the app is not on the WebView screen) before Web Inspector settings.
- `vitals` with a URL instead of a path (`vitals https://…`) fails with a clear message. On Android it failed with "Cannot navigate to invalid URL", and on iOS it printed a row of dashes.
- `--platform`, `--preset`, `--sse` and `--throttle` are narrowed where they are checked; before, the flag object was cast to the config type after a separate check.
- The `angular` preset bridges the HMR WebSocket of Angular 17+ (`@angular/build` on Vite, `wss://host/?token=…`). It pointed at `/ng-cli-ws`, the webpack dev server's path, so `ng serve` edits never reached the WebView.
- `dev` on Android follows the app when it recreates its WebView (rotation, a new screen): the old page stays alive but hidden, and the override now moves to the WebView on screen instead of serving the hidden one.
- **`dev` HMR for Vite-based stacks (Vite, Nuxt, SvelteKit, Angular):** the WebSocket bridge dropped the subprotocol the page asked for, and Vite only upgrades `vite-hmr` / `vite-ping` sockets, so HMR never connected. The subprotocols are now forwarded and the negotiated one is reported back to the page.
- `--logs`: an uncaught exception prints as `Error: message` with its stack instead of the object preview `{stack: …, message: …}`.
- `devtools` / `dev` / `vitals` print the `adb` path again (it was skipped when driver detection had already found adb).
- **iOS DevTools, `--logs` and `vitals` on iOS 12.2+ (every supported iOS):** WebKit page sockets only accept commands routed through its targets, so every command failed with "'Runtime' domain was not found". Commands now go through `Target.sendMessageToTarget` (the page target, followed across navigations) and replies are unwrapped from `Target.dispatchMessageFromTarget`, with a fallback to direct messages on older iOS.
- **iOS DevTools UI did not load:** the pinned Chrome DevTools frontend revision did not exist on appspot (404). It is now a verified revision and can be overridden with `WEBVIEW_LENS_DEVTOOLS_REVISION`.
- **`ios_webkit_debug_proxy` auto-start:** it was started with `-f`, which is `--frontend URL` and needs an argument, so the proxy exited at once. It now starts with its default ports; the hints in `doctor` say the same.
- **iOS `vitals` hung:** WebKit has no `Page.navigate`; navigation is now done in the page (`location.assign`). The CLI also passed the Android forward port (9223) to the iOS driver, which then looked for pages on the wrong port; `vitals` and `dev --logs` now start `ios_webkit_debug_proxy` like `devtools` does.
- **iOS CLS reported 🟢 0.000:** WebKit has no layout-shift entries, so CLS stayed at its initial 0. It is now `n/a` where layout shifts cannot be observed. The docs now say what iOS 26.6 measures: LCP and Event Timing yes, CLS no.
- An iPhone connected over USB and Wi-Fi at once is listed once.
- **iOS `dev` proxy setup is checkable:** the setup page (`http://<mac-ip>:8888/`) links two self-checks: `http://webview-lens.check/` answers **Proxy: OK** only through the proxy, and `https://<remote>/__webview-lens/ok` answers **Interception: OK** only when the CA is trusted. Both also log a line in the terminal. `docs/ios.md` has the flow step by step and a symptom → cause → fix table.
- **Android: the WebView on screen is the one used.** An app keeps the WebViews of screens below the current one alive, all on the same URL; `dev`, `devtools` and `vitals` took the first one listed, often a hidden one. They now prefer the page DevTools reports as attached (on screen).
- README: running several devices at once (checked with an Android phone and an iPhone sharing one dev server and HMR).
- Bypassed requests that fail show the cause (`fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)`) and, for a stand with a private CA, the fix: `NODE_EXTRA_CA_CERTS`.
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
