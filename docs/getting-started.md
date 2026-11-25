# Getting Started

From `npm install` to DevTools, your local dev server and Web Vitals inside a real app, on Android
and iOS. Each step says what you should see, so you know where you are.

## 1. Install

```bash
npm i -D webview-lens     # Node.js 22.4+; nothing else is installed with it
npx webview-lens init     # writes webview-lens.config.json for your bundler (optional)
```

## 2. Make the app's WebView debuggable (test builds)

| Stack                     | Android                                                     | iOS (16.4+)                                                             |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Native (Kotlin / Swift)   | `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` | `webView.isInspectable = true`                                          |
| Flutter `webview_flutter` | `AndroidWebViewController.enableDebugging(true)`            | `(controller.platform as WebKitWebViewController).setInspectable(true)` |
| React Native WebView      | `webviewDebuggingEnabled` prop                              | `webviewDebuggingEnabled` prop                                          |
| Capacitor / Cordova       | on in debug builds                                          | on in debug builds                                                      |

Without this, the WebView does not show up anywhere; `doctor` says so.

## 3. Android

1. Phone: **Settings → About → tap Build number 7 times**, then **Developer options → USB debugging** on.
   Xiaomi / MIUI also needs **Install via USB** and **USB debugging (Security settings)**.
2. Connect the cable, allow the computer on the phone, open the app's WebView screen.
3. Check:

```bash
npx webview-lens doctor
```

You should see `✓ phone connected`, `✓ app on screen: <your package>` and `✓ debuggable WebViews: …`.
`adb` is found on its own (Android SDK, `ANDROID_HOME`, `PATH`, `~/Downloads`); set `ADB` if it is elsewhere.

4. Use it:

```bash
npx webview-lens devtools --logs                                  # DevTools at http://localhost:3300
npx webview-lens dev http://localhost:5173 --remote https://stand.example.com
npx webview-lens vitals / /catalog --runs 3 --budget lcp=2500
```

`dev` keeps the WebView on the stand's HTTPS origin and answers its requests from your dev server:
the page shows your local code, with the stand's cookies and the real native bridge.

## 4. iOS (macOS and Windows)

1. Computer: `ios_webkit_debug_proxy` (`brew install ios-webkit-debug-proxy`, or Scoop on Windows) and, on
   Windows, Apple Devices or iTunes. webview-lens starts the proxy itself.
2. iPhone: **Settings → Safari → Advanced → Web Inspector** on. Connect the cable, tap **Trust**.
3. Check and use:

```bash
npx webview-lens doctor --platform ios
npx webview-lens devtools --platform ios --logs                   # Chrome DevTools for the WKWebView
npx webview-lens vitals / --platform ios
```

4. Local dev server inside the iOS app goes through a Wi-Fi proxy on your computer:
   `npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com`, then
   follow the eight steps in [iOS setup](ios.md#how-the-proxy-flow-works-step-by-step) (the proxy checks
   itself: **Proxy: OK**, **Interception: OK**).

With several devices at once, run one `webview-lens` per device: see the README.

## 5. Environment variables

| Variable                           | What it sets                                                   | Default                                |
| ---------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `ADB`                              | path to `adb`                                                  | found in the Android SDK, PATH…        |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Android SDK location (for `adb`)                               | `~/Library/Android/sdk` and others     |
| `ANDROID_SERIAL`                   | which Android phone, when several are connected (`--serial`)   | the only one                           |
| `DEVTOOLS_PORT`                    | local port forwarded to the WebView DevTools socket (`--port`) | `9223`                                 |
| `DEVTOOLS_LINK_PORT`               | fixed DevTools address (`--link-port`)                         | `3300`                                 |
| `LOCAL_URL`                        | local dev server for `dev`                                     | `http://localhost:3000`                |
| `IWDP`, `IOS_WEBKIT_DEBUG_PROXY`   | path to `ios_webkit_debug_proxy`                               | PATH, Homebrew, Scoop                  |
| `DEVTOOLS_FRONTEND_ORIGIN`         | mirror of the Chrome DevTools frontend (corporate networks)    | `chrome-devtools-frontend.appspot.com` |
| `WEBVIEW_LENS_DEVTOOLS_REVISION`   | DevTools frontend revision for iOS                             | a verified revision                    |
| `WEBVIEW_LENS_DEBUG=1`             | what webview-lens itself does, on stderr (`--verbose`)         | off                                    |
| `WEBVIEW_LENS_LOG_FILE`            | the same as JSON Lines in a file (`--log-file`)                | off                                    |
| `NODE_EXTRA_CA_CERTS`              | trust a stand with a private CA for `--bypass` requests (Node) | system CAs                             |

## 6. Project config (`webview-lens.config.json`)

Flags override it. Every key is optional and validated on start.

```json
{
    "platform": "auto",
    "preset": "vite",
    "local": "http://localhost:5173",
    "remote": "https://stand.example.com",
    "cmd": "npm run dev",
    "bypass": ["/api"],
    "logs": true,
    "app": "com.example.app.debug",
    "budget": "lcp=2500,cls=0.1"
}
```

## 7. When something does not work

1. `npx webview-lens doctor` (add `--platform ios` for iOS): the first ✗ line is the problem.
2. Add `--verbose` to any command: every adb call, port forward, socket and proxy decision on stderr.
   `--log-file run.jsonl` keeps it as a file for a bug report.
3. iOS proxy: the [symptom → cause → fix table](ios.md#when-it-does-not-work).

Next: [Recipes](recipes.md) for keyboards, safe areas, signing the WebView in, the native bridge and
scripting webview-lens from your own code.
