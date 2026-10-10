# webview-lens

See, override and measure the web page that lives inside a native app's **Android WebView**, from
your computer. Also included: a small **RUM** (real user monitoring) client and server pair for the
same page in production.

A page in a WebView differs from the same page in desktop Chrome: it has a native JS bridge, the
app's User-Agent, theme and locale, and often an app that refuses cleartext `http://`. webview-lens
works with the real app on a real phone over adb and the Chrome DevTools Protocol, with no changes
to the app.

| Piece                     | What it does                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `webview-lens dev`        | The WebView keeps its https origin, and every request to that origin is served from your local dev server (CDP `Fetch`) |
| `webview-lens devtools`   | Full DevTools for the WebView page at a **fixed** `http://localhost:3300`, which survives app restarts                  |
| `webview-lens vitals`     | Lab LCP, FCP, CLS, INP and TTFB measured on the phone: median of N runs, cold or warm cache, Markdown report            |
| `webview-lens doctor`     | Shows what blocks the connection: adb, phone authorization, locked screen, debuggable WebViews, pages                   |
| `webview-lens/rum`        | Browser: Web Vitals and uncaught errors sent with `sendBeacon`, no dependencies, sampling, privacy-safe paths           |
| `webview-lens/rum/server` | Fetch API handlers (`Request → Response`) for Next.js, Hono, Bun, Deno and others, with size limits and checked fields  |

## Requirements

- Node.js 22.4+ for the CLI. The `rum` entry points have no Node requirement.
- A phone with USB debugging on, connected over USB.
- A debuggable WebView: the app calls `WebView.setWebContentsDebuggingEnabled(true)` (usual in debug or test builds).
- adb. It is found automatically in `ADB`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default Android SDK
  location, `PATH`, or a [platform-tools](https://developer.android.com/tools/releases/platform-tools)
  archive unpacked into `~/Downloads`.

```bash
npm i -D webview-lens
npx webview-lens doctor
```

## Local dev server inside the app

```bash
npx webview-lens dev http://localhost:3000 --cmd "npm run dev"
```

Open the WebView screen in the app. The tool attaches to it and reloads it, and from then on the page
is served by your code. The address bar still shows the stand's https origin, so the native bridge,
cookies on that domain and a `'self'` CSP all keep working.

- `--preset auto|next|vite|webpack|nuxt|angular|generic` picks bundler defaults for WebSocket HMR and quiet request logs (by default `auto` detects from `package.json`).
- `--remote https://stand.example.com` sets the origin to override. By default it is the origin the WebView is on.
- `--remote-base /shop` and `--local-base /` map a stand subpath to your local server root (rewriting requests, `Referer`, and `Location` redirects).
- `--ws /_next/` bridges WebSockets under that prefix to the local server; the option can be repeated.
  CDP `Fetch` does not intercept WebSockets, so the page gets a stub `WebSocket` that relays frames
  through a CDP binding.
- `--hmr-port 24678` bridges a separate local HMR WebSocket port (common in Vite/Webpack) over CDP, avoiding Mixed Content issues on `https://` WebViews.
- `--quiet <prefix>` hides noisy asset paths from request logs; `--bypass <prefix>` passes paths straight through to the stand (e.g. live SSE streams).
- `--sse fail|continue` controls how `text/event-stream` responses from the local server are handled without hanging CDP `Fetch` (default `fail`).
- `--logs` streams `console.*`, uncaught exceptions, and 4xx/5xx or failed network requests from the phone right into your terminal (works in `dev` and `devtools`).
- `--serial <id>` (or `ANDROID_SERIAL`) picks a specific phone when multiple devices are connected; `--app <package>` pins WebView discovery to a specific Android package.
- `--match text` attaches to the page whose URL contains `text`.
- Press Enter to reload the page on the phone. Ctrl+C exits and stops a server started with `--cmd`.

While it runs, DevTools for the page are at `http://localhost:3300`.

## DevTools at a fixed address

```bash
npx webview-lens devtools
```

`devtools://…/page/<id>` cannot be opened as a link, and the id changes on every app restart.
Opening `chrome-devtools-frontend.appspot.com` in a normal tab shows an empty UI, because its CSP
blocks `ws://localhost`. This command serves the DevTools frontend of the WebView's own revision
from localhost and pipes the inspector socket to the phone without the browser's `Origin`. You get
one bookmark that always opens the current page.

## Lab Web Vitals from the phone

```bash
npx webview-lens vitals / /events "/event/42" --runs 3 --cold --out reports/vitals.md
```

The command measures whatever origin the WebView is on. To measure a production build of your code,
run `webview-lens dev http://localhost:3001 --cmd "npm run build && npm start -- -p 3001"` in a
second terminal. `--interact 10` gives you 10 seconds to tap around after each load, so INP gets
measured. On Git Bash, paths like `/events` are fixed back from `C:/Program Files/Git/events`.

## RUM

### Browser

```ts
import { captureGlobalErrors, createErrorReporter, createVitalsReporter } from 'webview-lens/rum';
import { onCLS, onINP, onLCP, onFCP, onTTFB } from 'web-vitals';

const report = createVitalsReporter({ endpoint: '/api/vitals', sampleRate: 0.5 });
[onCLS, onINP, onLCP, onFCP, onTTFB].forEach((on) => on(report));

captureGlobalErrors(createErrorReporter({ endpoint: '/api/client-log' }));
```

In Next.js, use `useReportWebVitals(report)` and create `report` at module scope.

The path sent with each metric is `location.pathname` without the query or hash, limited to route
characters. To group pages and keep ids out of the data, pass `path: () => '/event/[id]'` or
`path: () => '/event/:id'`.

### Server

```ts
// app/api/vitals/route.ts (Next.js)
import { createVitalsHandler } from 'webview-lens/rum/server';

export const POST = createVitalsHandler({
    onMetric: ({ name, value, rating, path }) =>
        logger.info(`${name} ${rating} ${path}`, { value }),
});
```

For `node:http`, Express, Connect, or NestJS, wrap the handler with `toNodeHandler`:

```ts
import { createVitalsHandler, toNodeHandler } from 'webview-lens/rum/server';

app.post('/api/vitals', toNodeHandler(createVitalsHandler({ onMetric: (m) => logger.info(m) })));
```

```ts
// app/api/client-log/route.ts
import { createClientLogHandler } from 'webview-lens/rum/server';

export const POST = createClientLogHandler({
    onLog: ({ message, fields, userAgent }) => logger.error(message, { ...fields, userAgent }),
});
```

Both endpoints are public. Bodies are read as a stream and cut at the limit (2 KiB for vitals,
16 KiB for logs). A vital must match its schema exactly; a log entry is limited by field count and
value length. Only checked fields reach your callback.

## API

Everything the CLI uses is exported from `webview-lens`: `findAdb`, `forwardWebView`,
`waitForPage`, `connectCdp`, `startDevtoolsLink`, `startOverride`, `measureVitals`, `toMarkdown`
and others. This way you can script your own flows, such as a CI job against a device farm.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md).

## Limitations

- Android only. iOS WKWebView uses a different protocol (`ios_webkit_debug_proxy`).
- The lab INP counts only the taps you make during `--interact`.
- Production numbers come from RUM; lab numbers from a dev server are inflated.

## License

MIT
