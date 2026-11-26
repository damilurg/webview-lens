# How it was verified

What webview-lens claims, how each claim was checked on real phones, what was observed, and which
test keeps it from breaking. Tests use doubles that replay what the devices did (captured with
`--log-file` or `webview-lens keyboard`), so a regression fails CI without a phone.

## Test bed

| Part     | What                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | Redmi Note 8 Pro, Android 11, Android System WebView 157, over USB (`adb`)                                                                                                 |
| iPhone   | iPhone 17 Pro, iOS 26.6.1, over USB (`usbmuxd`, `ios_webkit_debug_proxy`) and Wi-Fi to the Mac                                                                             |
| Apps     | A Kotlin app (Android) and a Flutter app (`webview_flutter`, Android and iOS), both signing in natively and opening the stand in a WebView with a JS bridge                |
| Stand    | An HTTPS origin with its own CA: sign-in API, session cookie, RUM collector with Prometheus `/metrics`; as a static host or a reverse proxy in front of a framework server |
| Web apps | Vite, Next.js 16 (SSR, SSG, Server Action, static export), Nuxt 4, SvelteKit 3, Angular 22                                                                                 |
| Date     | 2026-11-25 – 2026-11-26                                                                                                                                                    |

## Claims and evidence

| Claim                                                                          | How it was checked                                                                                                                          | Observed                                                                                                                                        | Guarded by                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `dev` serves the stand's origin from the local server inside the app (Android) | Kotlin app, `dev http://127.0.0.1:5173 --remote https://localhost:8443 --logs`, page state read over CDP                                    | page badge "local dev server", session from the native sign-in, bridge "Connected to Kotlin (android)"                                          | `test/override.test.ts`, `test/bdd/framework-agnostic.bdd.test.ts`       |
| HMR works through the bridged WebSocket                                        | an edit to `main.ts` while the app is open (Android: Vite, Next.js, Nuxt, SvelteKit, Angular; iOS: Vite, Next.js, Nuxt, SvelteKit, Angular) | heading changed without a reload (`navigation` entries stayed 1)                                                                                | `test/override.test.ts` (`vite-hmr` subprotocol), `test/presets.test.ts` |
| `dev` on iOS through the selective MITM proxy                                  | Flutter app on the iPhone with the Wi-Fi proxy on port 8888                                                                                 | "local dev server" badge, cookie from the native sign-in, HMR                                                                                   | `test/ios-mitm.test.ts`, `test/bdd/ios-mitm.bdd.test.ts`                 |
| `--logs` streams console, exceptions and failed requests                       | `console.warn`, a thrown error and `fetch('/api/fail')` evaluated in the Android page                                                       | `[console.warn] smoke warn`, `[exception] Error: smoke boom`, `[network] 500 GET …/api/fail`                                                    | `test/telemetry.test.ts`, `test/bdd/live-telemetry.bdd.test.ts`          |
| `dev` follows the WebView the app recreates (rotation, new screen)             | found on the Kotlin app: after a rotation `dev` kept serving the replaced, hidden WebView                                                   | fixed in code; on the phone the app was then changed to keep its WebView, so the switch itself is covered by the test only                      | `test/device.test.ts`                                                    |
| SSR sees the native sign-in; `--forwarded` gives the server the stand's URL    | Next.js 16, Nuxt 4, SvelteKit 3, Angular 22 dev servers and production builds, both phones                                                  | "Signed in as Demo User (session read on the server)", absolute URL `https://<stand>/`; framework-specific settings in [SSR](ssr.md)            | `test/ssr.test.ts`                                                       |
| Server Actions, form actions and POST routes pass CSRF checks under `dev`      | the forms submitted from the WebView with and without `--forwarded`                                                                         | passed; SvelteKit adapter-node and Angular need the settings in [SSR](ssr.md) (403 / 400 otherwise, reproduced)                                 | `test/ssr.test.ts`                                                       |
| RUM from production builds reaches the collector, split by container           | stand as a reverse proxy in front of each production build (no webview-lens in the path), both apps                                         | `/metrics` series per path with `env="android-webview"` and `env="ios-wkwebview"` for Next.js (SSR and static export), Nuxt, SvelteKit, Angular | `test/rum-aggregator.test.ts`, `test/web/rum-reporters.test.ts`          |
| Lab vitals on the phone                                                        | `vitals /` on the stand page                                                                                                                | Android: LCP 244 ms, FCP 180 ms, CLS 0.000, TTFB 41 ms. iPhone: LCP 251 ms, FCP 165 ms, CLS n/a, TTFB 129 ms                                    | `test/vitals-lab.test.ts`, `test/bdd/performance-rum.bdd.test.ts`        |
| CLS is `n/a` on iOS                                                            | `vitals` on the iPhone                                                                                                                      | WebKit has no layout-shift entries                                                                                                              | `test/vitals-lab.test.ts`                                                |
| Keyboard numbers (`webview-lens/viewport`, `webview-lens keyboard`)            | `keyboard --overlay` in both apps, fields tapped on the phones                                                                              | Android: keyboard 255 px, covers 0 px. iPhone (Flutter): two phases, keyboard 369 px, then covers 0 px. Details in [Recipes](recipes.md)        | `test/web/viewport.test.ts`, `test/keyboard-probe.test.ts`               |
| Several phones on one dev server                                               | the Android phone and the iPhone open at once                                                                                               | one edit reloaded both                                                                                                                          | n/a (manual)                                                             |

## Found on the phones and fixed

Each of these passed the tests that existed at the time, because their doubles followed our
assumptions. The tests now replay what the device did.

| Found                                                                                                     | Where            | Fix and test                                                                      |
| --------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| The `angular` preset bridged `/ng-cli-ws` (webpack era); Angular 17+ HMR runs on Vite at the page origin  | Android, Angular | preset bridges `/`; `test/presets.test.ts`                                        |
| `dev` kept serving a WebView the app had replaced (rotation)                                              | Android, Kotlin  | follows the one on screen (not re-run on the phone); `test/device.test.ts`        |
| `--wl-keyboard-height` was 17 px too high after the WebView got shorter (a native status line appeared)   | iPhone, Flutter  | baseline resets while no field is focused; `test/web/viewport.test.ts`            |
| iOS overscroll (`visualViewport.offsetTop` −3 px) added to the keyboard height                            | iPhone           | negative offsets ignored; `test/web/viewport.test.ts`                             |
| A fixed bottom bar riding on the keyboard hid the field `keepFocusedInputVisible` had just made "visible" | iPhone, Flutter  | fixed and sticky bars counted (`unobstructedBottom`); `test/web/viewport.test.ts` |
| `vitals https://…` (a URL instead of a path) failed on Android and printed dashes on iOS                  | both             | clear error; `test/bdd/cli.bdd.test.ts`                                           |
| Prerendered HTML without `Cache-Control` stayed cached in both WebViews after a deploy                    | both, Nuxt       | documented with the fix ([SSR](ssr.md)); a stand behaviour, not a library one     |

## Not verified, or known not to work

- **iOS, Flutter, focus moving between fields with the keyboard open:** WKWebView scrolls the new
  field below the visible area and ignores scrolling from the page. Tried on the device:
  `scrollIntoView` (smooth and instant), `scrollBy`, setting `scrollTop`, re-focusing. None moved
  it. The first focus works. Needs a native-side fix.
- **iOS DevTools UI** after the protocol decoder refactor: covered by `test/bdd/ios-devtools-bridge.bdd.test.ts`, not re-opened on the iPhone.
- **Swift (UIKit/SwiftUI) apps** and **React Native:** the recipes follow Apple's documentation; no test app.
- **Android 15+ edge-to-edge** (`adjustResize` no longer resizes): recipe from the platform docs; the test phone runs Android 11.
