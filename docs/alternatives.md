# Alternatives: chrome://inspect, Safari Web Inspector, Eruda, HTTP proxies

How webview-lens compares with the tools people already use for a web page inside a mobile app, and
when one of those is the better choice.

| Need                                        | `chrome://inspect` | Safari Web Inspector | `ios_webkit_debug_proxy` | Eruda / vConsole    | HTTP proxy (Charles, Proxyman) | webview-lens |
| ------------------------------------------- | ------------------ | -------------------- | ------------------------ | ------------------- | ------------------------------ | ------------ |
| Android WebView                             | ✓                  | —                    | —                        | ✓ (injected script) | network only                   | ✓            |
| iOS WKWebView                               | —                  | ✓                    | ✓                        | ✓ (injected script) | network only                   | ✓            |
| iOS debugging on Windows                    | —                  | —                    | ✓ (no UI of its own)     | ✓                   | network only                   | ✓            |
| Full Chrome DevTools at a fixed URL         | —                  | —                    | —                        | —                   | —                              | ✓            |
| Local dev server behind the app's HTTPS     | —                  | —                    | —                        | —                   | ✓ (Map Remote)                 | ✓ (with HMR) |
| WebView logs in the terminal                | —                  | —                    | —                        | —                   | —                              | ✓            |
| Lab Web Vitals on a real phone + CI budgets | manual             | manual               | —                        | —                   | —                              | ✓            |
| Keyboard and viewport numbers               | manual             | manual               | —                        | —                   | —                              | ✓            |
| Production RUM + Prometheus                 | —                  | —                    | —                        | —                   | —                              | ✓            |

## `chrome://inspect`

Built into Chrome, nothing to install, enough for a quick look at an Android WebView. The DevTools
tab dies when the app restarts, there is nothing for iOS, and the page still runs against the
deployed site, not your dev server. webview-lens uses the same Android DevTools socket and adds a
stable address, reconnection, `--logs`, `dev` and `vitals` on top.

## Safari Web Inspector

The native tool for WKWebView, and the best one if you work on a Mac: it shows WebKit's own panels.
It needs a Mac, it has no command line, and you cannot point it at your dev server. On Windows, or to
use Chrome DevTools, the terminal and the same commands as on Android, use webview-lens.

## `ios_webkit_debug_proxy`

A proxy from the iPhone's inspector to a WebSocket; webview-lens runs it under the hood on iOS. On
its own it has no DevTools UI and speaks WebKit's protocol, which Chrome DevTools does not
understand; webview-lens translates it.

## Eruda and vConsole

A console drawn inside the page itself. It works on any phone without a cable, which is handy for a
tester's device or a production bug report. It is a script you ship (or inject), it sees only what
JavaScript can see, and it has no debugger, profiler or real network panel.

## HTTP proxies (Charles, Proxyman, mitmproxy)

The right tool for inspecting and rewriting traffic, including the native app's own API calls.
Map Remote can serve local files, but without HMR's WebSocket, and a proxy sees nothing of the page:
no console, no DOM, no performance. webview-lens's iOS `dev` mode is a proxy of this kind that
intercepts only your host and bridges the HMR socket.

## Native profilers

Android Studio and Xcode profile the app process. For the web page inside it, the browser engine's
own DevTools give more: that is what webview-lens connects to.
