# WebView problems and fixes

What goes wrong with a web page inside an Android WebView or an iOS WKWebView, why, and how to fix
it, with or without webview-lens. Each fix was checked on a real phone unless it says otherwise
([how](verification.md)).

## The WebView does not show up in `chrome://inspect`

Android lists only WebViews whose app turned debugging on. In the debug build:

| App                  | Switch                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| Android (Kotlin)     | `WebView.setWebContentsDebuggingEnabled(true)`                                          |
| Capacitor            | `webContentsDebuggingEnabled: true` in `capacitor.config`                               |
| React Native WebView | `webviewDebuggingEnabled` prop                                                          |
| Flutter              | `AndroidWebViewController.enableDebugging(true)`                                        |
| iOS 16.4+ (any)      | `webView.isInspectable = true`; Flutter: `WebKitWebViewController.setInspectable(true)` |

Then the phone needs USB debugging on, the screen unlocked and the app on the screen with the
WebView. `npx webview-lens doctor` checks each of these and prints the first one that fails.

## DevTools disconnects every time the app restarts

The `chrome://inspect` link points at one WebView instance; a restart creates a new one and the old
tab goes dead. `npx webview-lens devtools` serves Chrome DevTools at `http://localhost:3300` and
reconnects to the new page by itself, so the tab and your breakpoints stay. When the app keeps
several WebViews alive (an earlier screen in the stack), it follows the one on the screen.

## Debug an iOS WKWebView on Windows

Safari's Web Inspector runs only on a Mac. `npx webview-lens devtools --platform ios` works on Windows
and macOS: it finds the iPhone over USB (`usbmuxd`, from Apple Devices or iTunes on Windows), starts
`ios_webkit_debug_proxy` and translates the WebKit Inspector Protocol to Chrome DevTools, which opens
at `http://localhost:3300`. The app must set `webView.isInspectable = true` (iOS 16.4+), and Settings
→ Safari → Advanced → Web Inspector must be on. Step by step: [iOS on macOS and Windows](ios.md).

## Load your localhost dev server inside the app

Pointing the app at `http://10.0.2.2:3000` or your Mac's IP breaks what you want to test: cleartext
is blocked (`ERR_CLEARTEXT_NOT_PERMITTED`), the session cookie belongs to the real domain, and CSP,
OAuth callbacks and the native bridge expect the real HTTPS origin.

`npx webview-lens dev http://localhost:3000` keeps the app on its real HTTPS address and answers its
requests from your dev server, with hot reload. On Android it uses the DevTools protocol, no app
changes; on iOS a proxy that intercepts only your host (the iPhone trusts a local CA once). Requests
you list with `--bypass /api` still go to the real backend. Server-rendered apps (Next.js, Nuxt,
SvelteKit, Angular) need `--forwarded` and a setting or two: [SSR and SSG](ssr.md).

## See the WebView's `console.log` in the terminal

Add `--logs` to `dev` or `devtools`: console messages with their source location, uncaught
exceptions and requests that failed or returned 4xx/5xx are printed as they happen. To feed them to
your own tooling as JSON lines, see [Recipes](recipes.md#page-logs-as-json-lines-for-your-tooling-checked-on-android).

## The keyboard covers the input in a WebView

Android with `adjustResize` shrinks the WebView; iOS WKWebView keeps its size and only the visible
area shrinks, so a `position: fixed; bottom: 0` bar and the last fields end up under the keyboard.
`100vh` follows neither.

`webview-lens/viewport` measures it and sets CSS variables: `bottom: var(--wl-keyboard-inset)` for
fixed bars, `padding-bottom: var(--wl-scroll-room)` so the last fields can scroll above the keyboard,
and `keepFocusedInputVisible()` scrolls the focused field above the keyboard and any fixed bar. In
Flutter on iOS, also let WKWebView handle the keyboard. Code for the web side, Kotlin, Flutter and
Swift: [Recipes](recipes.md#keyboard-covers-the-input-or-the-bottom-bar). To see what the keyboard
does on your phone: `npx webview-lens keyboard --overlay`.

## `100vh` is wrong inside a WebView

`100vh` is the largest viewport, not the one the user sees, and it does not change with the keyboard.
Use `100dvh` where supported, or `var(--wl-viewport-height)` from `webview-lens/viewport`, which
follows the visible area on Android and iOS.

## iOS zooms in when an input gets focus

WKWebView and Safari zoom into fields with a font smaller than 16px. Keep inputs at 16px or more
([Recipes](recipes.md#ios-zooms-in-when-an-input-gets-focus)).

## Measure Core Web Vitals inside the app

Lighthouse on desktop Chrome measures a different browser on a different machine. `npx webview-lens
vitals / /catalog --runs 5` opens each screen in the app's WebView on the phone and reports the
median LCP, FCP, CLS, INP and TTFB, long tasks and JS heap, in a Markdown report. `--budget
lcp=2500,cls=0.1` exits with code 1 when a budget is exceeded, for CI. On Android, `--throttle` and
`--cpu` emulate a slow network and device. On iOS, CLS is `n/a`: WebKit reports no layout shifts.

## Web Vitals of real users of a WebView app

Analytics usually cannot tell a WebView from a browser. `webview-lens/rum` reports Web Vitals,
custom timings and JS errors with `env: android-webview | ios-wkwebview | browser`, and
`webview-lens/rum/server` aggregates them into p50/p75/p95 with a Prometheus `/metrics` endpoint, in
any runtime with the Fetch API (Node, Edge, Bun, Deno, Workers). [RUM and Prometheus](rum.md).

## The server-rendered page builds URLs for localhost

Under `webview-lens dev` the request reaches your SSR server from `localhost`. With `--forwarded`
it also gets `X-Forwarded-Host`, `X-Forwarded-Proto` and `Forwarded` for the real address, so
absolute URLs, canonical links and OAuth callbacks point at the right place. Next.js, Nuxt, SvelteKit
and Angular each read them differently: [SSR and SSG](ssr.md).

## The app shows old HTML after a deploy

A prerendered page served without `Cache-Control` but with `Last-Modified` is cached by the WebView
heuristically, so the app can keep showing the previous build. Send `Cache-Control: no-cache` for
HTML ([SSR and SSG](ssr.md)).

## Does it work with Capacitor, Cordova, Ionic, React Native or Flutter?

Yes. They all render in Android WebView and iOS WKWebView; the debug build has to allow WebView
debugging (see the first section). It was checked with a Kotlin app and a Flutter app; Capacitor,
Cordova and React Native use the same WebViews and switches.
