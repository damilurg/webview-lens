// `webview-lens --help`.

export const HELP = `webview-lens: inspect, override and measure the page inside an Android & iOS app's WebView.

Usage
  webview-lens init [options]              create a starter webview-lens.config.json for this project
  webview-lens dev [local-url] [options]   serve the WebView's origin from your local server
  webview-lens devtools [options]          DevTools of the WebView page at a fixed localhost URL
  webview-lens vitals [paths…] [options]   lab Web Vitals from the phone, Markdown report
  webview-lens cert [options]              serve local Root CA profile (.mobileconfig) for iOS setup
  webview-lens doctor                      what blocks the connection to the phone

Common options
  --config <file>   path to project config JSON (default: webview-lens.config.json if present)
  --platform <p>    device platform: auto, android, ios (auto)
  --port <n>        local port forwarded to the WebView DevTools socket (9223, env DEVTOOLS_PORT)
  --serial <id>     target Android device serial when multiple phones are connected (env ANDROID_SERIAL)
  --app <package>   pin WebView discovery to a specific Android package name
  --match <text>    attach to the page whose URL contains text (default: any https page)
  --logs            stream console logs, uncaught exceptions and 4xx/5xx network errors to terminal

dev
  local-url               local server (http://localhost:3000, env LOCAL_URL)
  --preset <name>         bundler defaults: auto, next, nuxt, sveltekit, angular, vite, webpack, generic (auto)
  --remote <url>          origin to serve (default: the origin the WebView is on)
  --remote-base <path>    stand subpath to override (e.g. /shop)
  --local-base <path>     local server subpath mapped to --remote-base (default: /)
  --cmd <command>         start the local server with this command when it does not answer
  --ws <prefix>           WebSocket path prefix bridged to the local server, repeatable
  --hmr-port <n>          separate local HMR port bridged over CDP, repeatable
  --quiet <prefix>        path prefix hidden from request logs, repeatable
  --bypass <prefix>       path prefix passed straight through to the stand, repeatable
  --sse <fail|continue>   handling of text/event-stream responses (fail)
  --forwarded             SSR reverse-proxy mode: send X-Forwarded-Host/Proto/Port and Forwarded
                          for the stand, keep Origin/Referer (absolute URLs, OAuth callbacks)
  --proxy-port <n>        HTTPS MITM proxy port for iOS dev / cert (8888)
  --link-port <n>         port of the DevTools link (3300, env DEVTOOLS_LINK_PORT)
  Enter reloads the page on the phone, Ctrl+C exits.

vitals
  paths             screens to open (default: /)
  --runs <n>        runs per screen, the median is reported (3)
  --cold            disable the cache (first visit)
  --interact <s>    seconds to tap around after load, for INP (0: not measured)
  --throttle <p>    network throttling on Android: none, fast-4g, slow-4g, 3g (none)
  --cpu <rate>      CPU slowdown multiplier on Android, e.g. 4 (1)
  --budget <spec>   CI thresholds, e.g. lcp=2500,cls=0.1 (exits 1 if exceeded)
  --out <file>      Markdown report (webview-vitals.md)

The phone: USB debugging on, the app's WebView debuggable (WebView.setWebContentsDebuggingEnabled).
adb is found in ADB, ANDROID_HOME, ANDROID_SDK_ROOT, the Android SDK, PATH and Downloads.`;
