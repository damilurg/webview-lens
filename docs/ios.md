# iOS WKWebView Setup (macOS & Windows)

`webview-lens` supports inspecting, overriding, and measuring iOS `WKWebView` screens from both **macOS** and **Windows** with zero runtime dependencies.

## 1. Prerequisites

| Requirement                                       | macOS                                             | Windows                                                                          |
| ------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| **USB transport (`usbmuxd`)**                     | Built into macOS (`/var/run/usbmuxd`)             | Install **Apple Devices** or **iTunes** from Microsoft Store (`127.0.0.1:27015`) |
| **WebInspector proxy (`ios_webkit_debug_proxy`)** | `brew install ios-webkit-debug-proxy`             | `scoop install ios-webkit-debug-proxy` (or unpack into `~/Downloads`)            |
| **Test build flag**                               | `webView.isInspectable = true` (iOS 16.4+)        | `webView.isInspectable = true` (iOS 16.4+)                                       |
| **iPhone setting**                                | _Settings → Safari → Advanced → Web Inspector_ ON | _Settings → Safari → Advanced → Web Inspector_ ON                                |

Verify everything with:

```bash
npx webview-lens doctor --platform ios
```

## 2. Inspecting & Live Logs in Chrome (macOS or Windows)

```bash
npx webview-lens devtools --platform ios --logs
```

- Automatically starts `ios_webkit_debug_proxy` if installed and not already running.
- Opens Chrome DevTools at `http://localhost:3300` through the built-in **WIP ↔ CDP bridge**.
- Streams `console.*` and failed network requests straight to your terminal with `--logs`.

## 3. Running Your Local Dev Server Inside the iOS App (`webview-lens dev`)

Because WebKit Inspector Protocol has no equivalent to Chromium's `Fetch.fulfillRequest`, `webview-lens` uses a **selective local HTTPS MITM proxy** that intercepts **only** your `--remote` host (HTTP + native WebSocket HMR) and tunnels every other domain untouched via raw TCP `CONNECT`.

### One-time certificate setup on the test iPhone

```bash
npx webview-lens cert
```

1. Open the printed `http://<your-lan-ip>:8888/` URL in Safari on the iPhone.
2. Tap **Download iOS Profile (.mobileconfig)**.
3. Install it in **Settings → General → VPN & Device Management**.
4. Enable full trust in **Settings → General → About → Certificate Trust Settings**.
5. Make sure **SSL Pinning is disabled** in your debug/test iOS build.

### Start local override

```bash
npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com --cmd "npm run dev" --logs
```

On the iPhone, set **Settings → Wi-Fi → (i) → Configure Proxy → Manual** to the printed LAN IP and port (`8888`). Open your WebView screen in the app — it now loads directly from your local dev server with full HMR.
