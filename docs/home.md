# Debug the web page inside your mobile app

Your web app ships inside an Android WebView or an iOS WKWebView, and that is where it breaks: the
native sign-in cookie, the JS bridge, the keyboard, the app's own HTTPS origin. Desktop Chrome has
none of that. `chrome://inspect` loses the page every time the app restarts, Safari's inspector
needs a Mac, the app cannot load your `localhost`, and the logs stay on the phone.

webview-lens is a command-line tool and three small browser modules for that page. It works from
macOS, Windows and Linux with an Android phone or an iPhone on USB.

```bash
npm i -D webview-lens
npx webview-lens doctor        # what is missing on the computer and on the phone
```

## What it does

| Command                                  | What you get                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `webview-lens devtools`                  | Chrome DevTools for the app's page at `http://localhost:3300`. It stays connected when the app restarts. iPhone included. |
| `webview-lens dev http://localhost:5173` | The app opens your dev server under its real HTTPS address, with hot reload, the session cookie and the bridge intact.    |
| `--logs`                                 | `console.log`, uncaught errors and failed requests of the page, in your terminal.                                         |
| `webview-lens vitals /`                  | LCP, FCP, CLS, INP and TTFB measured on the phone, a Markdown report, and a non-zero exit code over a budget for CI.      |
| `webview-lens keyboard --overlay`        | What the on-screen keyboard does to the page: its height, what it covers, whether the focused field is hidden.            |

And for the page itself: `webview-lens/viewport` keeps fixed bars and focused fields above the
keyboard on both platforms, and `webview-lens/rum` sends Web Vitals of real users to your server,
tagged by container (`android-webview`, `ios-wkwebview`, `browser`), with a Prometheus endpoint.

## When you need it

- [The WebView does not show up in `chrome://inspect`](troubleshooting.md#the-webview-does-not-show-up-in-chrome-inspect)
- [DevTools disconnects every time the app restarts](troubleshooting.md#devtools-disconnects-every-time-the-app-restarts)
- [You need to debug an iOS WebView on Windows](troubleshooting.md#debug-an-ios-wkwebview-on-windows)
- [The app should load your localhost dev server](troubleshooting.md#load-your-localhost-dev-server-inside-the-app)
- [The keyboard covers the input in a WebView](troubleshooting.md#the-keyboard-covers-the-input-in-a-webview)
- [You want Web Vitals from inside the app, not from desktop Chrome](troubleshooting.md#measure-core-web-vitals-inside-the-app)

All problems and fixes: [WebView problems](troubleshooting.md). How it compares with
`chrome://inspect`, Safari Web Inspector, Eruda and HTTP proxies: [Alternatives](alternatives.md).

## Try it on Android in two minutes

1. Turn on USB debugging on the phone and connect it.
2. In the app's debug build, enable WebView debugging: `WebView.setWebContentsDebuggingEnabled(true)`.
   Capacitor, React Native WebView and Flutter have their own switch, see
   [Getting started](getting-started.md).
3. Open the screen with the WebView and run:

```bash
npx webview-lens devtools --logs
```

Open `http://localhost:3300` in Chrome. For an iPhone add `--platform ios`; the steps are in
[iOS on macOS and Windows](ios.md).

## Checked on real phones

Every feature on this site was run on a Redmi Note 8 Pro (Android 11) and an iPhone 17 Pro
(iOS 26.6.1), in a Kotlin app and a Flutter app with a native sign-in, against Vite, Next.js 16,
Nuxt 4, SvelteKit 3 and Angular 22. What was checked, what was measured and what was found on the
phones is listed in [How it was verified](verification.md).

It works with any app that embeds a WebView: native Android and iOS, Capacitor, Cordova, Ionic,
React Native WebView and Flutter. MIT licensed, no runtime dependencies.
