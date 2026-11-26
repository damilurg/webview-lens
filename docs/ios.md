# iOS WKWebView Setup (macOS & Windows)

`webview-lens` supports inspecting, overriding, and measuring iOS `WKWebView` screens from both **macOS** and **Windows** with zero runtime dependencies.

## 1. Prerequisites

| Requirement                                       | macOS                                                                                                                                                                                                     | Windows                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **USB transport (`usbmuxd`)**                     | Built into macOS (`/var/run/usbmuxd`)                                                                                                                                                                     | Install **Apple Devices** or **iTunes** from Microsoft Store (`127.0.0.1:27015`) |
| **WebInspector proxy (`ios_webkit_debug_proxy`)** | `brew install ios-webkit-debug-proxy`                                                                                                                                                                     | `scoop install ios-webkit-debug-proxy` (or unpack into `~/Downloads`)            |
| **Test build flag**                               | `webView.isInspectable = true` (iOS 16.4+)                                                                                                                                                                | `webView.isInspectable = true` (iOS 16.4+)                                       |
| **iPhone setting**                                | _Settings → Safari → Advanced → Web Inspector_ ON                                                                                                                                                         | _Settings → Safari → Advanced → Web Inspector_ ON                                |
| **Network for `dev`**                             | the iPhone and this computer on the same Wi-Fi, without client isolation; `devtools` and `--logs` need only USB ([why](troubleshooting.md#the-phone-cannot-reach-your-computer-keep-them-on-one-network)) | same                                                                             |

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

The proxy listens on all interfaces but only serves clients from loopback, private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local and CGNAT (`100.64/10`) addresses, so it is not an open proxy on a public interface. Pass `allowClient` to `startIosMitmProxy` to change that rule. An `https://` local dev server (Vite/Angular `--https`) works for WebSocket HMR too; its self-signed certificate is trusted on `localhost` only.

### How the proxy flow works, step by step

`webview-lens dev --platform ios` starts one HTTP proxy on your Mac (port `8888`). The iPhone sends
**all** its Wi-Fi traffic there; the proxy decrypts only the `--remote` host with its own CA and serves
it from your local dev server, and tunnels every other host untouched.

| Step | On the iPhone                                                                         | You should see                                                     |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | Safari: **`http://<mac-ip>:8888/`** (http, not https)                                 | "webview-lens iOS setup" with a profile button                     |
| 2    | Download the profile, then Settings → General → VPN & Device Management → install     | "webview-lens Local CA" installed                                  |
| 3    | Settings → General → About → Certificate Trust Settings → enable full trust           | the switch for "webview-lens Local CA" is on                       |
| 4    | Settings → Wi-Fi → (i) → Configure Proxy → **Manual**: Server `<mac-ip>`, Port `8888` | —                                                                  |
| 5    | Safari: **`http://webview-lens.check/`**                                              | **Proxy: OK** (and `proxy check OK` in the terminal)               |
| 6    | Safari: **`https://<remote-host>/__webview-lens/ok`**                                 | **Interception: OK** (and `interception check OK` in the terminal) |
| 7    | Open the app (or the stand in Safari)                                                 | your local build, with request lines (`200 GET /`) in the terminal |
| 8    | When done: Configure Proxy → **Off**                                                  | normal internet without the Mac                                    |

### When it does not work

| Symptom                                                              | Cause                                                                 | Fix                                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safari cannot open `https://<mac-ip>:8888/` (TLS error)              | the proxy port speaks plain HTTP                                      | open `http://<mac-ip>:8888/`                                                                                                                                                 |
| `http://webview-lens.check/` does not open                           | the iPhone does not use the proxy                                     | Configure Proxy → Manual on the Wi-Fi network you are on; Server = the IP the terminal prints (check for typos), Port `8888`                                                 |
| The check opens but `…/__webview-lens/ok` shows "Not Private"        | the CA is installed but not trusted                                   | step 3: Certificate Trust Settings → enable full trust                                                                                                                       |
| Both checks pass, the app still shows the stand                      | the app pins its certificates, or the page came from a cache          | test build without SSL pinning; reload the screen (or press Enter in the terminal)                                                                                           |
| No `200 GET …` lines, only `[console…]` lines                        | `--logs` runs over USB, the page itself does not go through the proxy | step 5 first                                                                                                                                                                 |
| `MITM FAIL … (UNABLE_TO_VERIFY_LEAF_SIGNATURE)` for `--bypass` paths | the stand uses a private CA that Node does not trust                  | start with `NODE_EXTRA_CA_CERTS=/path/to/stand-ca.pem`                                                                                                                       |
| `No device has connected to the proxy at … in 30 s`                  | the iPhone does not reach this computer                               | the same Wi-Fi, not a guest network that isolates devices, no VPN on the phone ([details](troubleshooting.md#the-phone-cannot-reach-your-computer-keep-them-on-one-network)) |
| `This computer's network address changed: A → B`                     | another network or a new DHCP lease                                   | Configure Proxy → Server B                                                                                                                                                   |
| `Proxy refused client … (not a private network)`                     | the client is not on a private network                                | use the Mac's LAN IP on the same Wi-Fi                                                                                                                                       |
| No internet on the iPhone after you stopped `dev`                    | the Wi-Fi proxy still points at the Mac                               | Configure Proxy → Off                                                                                                                                                        |
