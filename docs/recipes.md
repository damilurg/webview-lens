# Recipes

Fixes for what WebView developers hit again and again, with the web side and the native side
(Kotlin, Flutter, Swift), plus scripts that drive webview-lens from your own code. Snippets marked
**checked** were run in test apps (Kotlin and Flutter, with a native sign-in) on a real Android phone
and iPhone; the others follow the platform documentation.

## Keyboard covers the input or the bottom bar

The keyboard behaves differently in each container. Android with `adjustResize` shrinks the WebView;
iOS WKWebView keeps it and only shrinks the visual viewport; `100vh` follows neither. A bar with
`position: fixed; bottom: 0` ends up under the keyboard on iOS and is fine on Android.

**Web** (checked): `webview-lens/viewport` measures it and writes CSS variables on `<html>`.

<!-- example: examples/recipes/keyboard.ts -->

```ts
// Browser side: keep fixed bars and focused fields above the on-screen keyboard in Android WebView
// and iOS WKWebView. Call once at app start (client only; it does nothing during SSR).

import { keepFocusedInputVisible, watchViewport } from 'webview-lens/viewport';

export const setupKeyboard = () => {
    const stopViewport = watchViewport({
        onChange: ({ keyboardOpen, keyboardHeight }) => {
            document.body.classList.toggle('keyboard-open', keyboardOpen);
            console.debug(`keyboard ${keyboardOpen ? `open, ${keyboardHeight}px` : 'closed'}`);
        },
    });
    const stopFocus = keepFocusedInputVisible({ margin: 24 });

    return () => {
        stopViewport();
        stopFocus();
    };
};
```

<!-- /example -->

```css
.composer {
    position: fixed;
    bottom: var(--wl-keyboard-inset, 0px); /* iOS: keyboard height; Android adjustResize: 0 */
}
.screen {
    height: var(--wl-viewport-height, 100dvh); /* instead of 100vh */
}
body {
    /* Lets the last fields scroll above the keyboard: a WKWebView in an app adds no scroll room
       for it (measured), so without this they stay under it. 0 where the WebView resized. */
    padding-bottom: var(--wl-scroll-room, 0px);
}
```

| Variable / attribute   | Meaning                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `--wl-keyboard-inset`  | part of the page under the keyboard: what fixed bars move up by (0 where the WebView resized) |
| `--wl-keyboard-height` | keyboard height (0 when closed)                                                               |
| `--wl-viewport-height` | visible height                                                                                |
| `--wl-scroll-room`     | room to add at the end of the page so its last fields can scroll above the keyboard           |
| `data-wl-keyboard`     | `open` / `closed` on `<html>`                                                                 |

**Android (Kotlin).** Keep `android:windowSoftInputMode="adjustResize"` on the activity. Apps that
target SDK 35+ run edge-to-edge on Android 15+, where `adjustResize` no longer resizes the window:
apply the keyboard and system bar insets yourself (API 30+; use AndroidX `ViewCompat` below 30).

```kotlin
webView.setOnApplyWindowInsetsListener { view, insets ->
    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
    WindowInsets.CONSUMED
}
```

**Flutter.** On Android keep the default `Scaffold(resizeToAvoidBottomInset: true)`: the
`WebViewWidget` shrinks and `--wl-keyboard-inset` stays 0. On iOS turn it off and let WKWebView
handle the keyboard, and stop WKWebView adding the safe area to its insets (webview_flutter has no
Dart API for it, so it takes a few lines of Swift). Both measured on an iPhone: with the resize,
WKWebView scrolled a newly focused field by the old geometry; with the automatic insets, a focused
field in a fixed bar moved 33 px under the keyboard.

```dart
Scaffold(resizeToAvoidBottomInset: !Platform.isIOS, body: WebViewWidget(controller: controller))

// after the first page load (onPageFinished), iOS only:
const MethodChannel('app/webview_insets').invokeMethod<int>('neverAdjust');
```

```swift
// AppDelegate: on "neverAdjust", for every WKWebView in the app's windows
webView.scrollView.contentInsetAdjustmentBehavior = .never
```

**iOS (Swift).** WKWebView is not resized; leave it so and use `--wl-keyboard-inset` on the page.
With `viewport-fit=cover`, avoid double insets: `webView.scrollView.contentInsetAdjustmentBehavior = .never`.

### Seeing what the keyboard does: `webview-lens keyboard`

```bash
npx webview-lens keyboard --overlay            # Android; add --platform ios for an iPhone
```

One line per change: the keyboard height, how much of the page it covers, the visible height, the
focused field (`visible`, `partly hidden`, `HIDDEN`, and whether a fixed bar such as a composer is
the reason), and the `--wl-*` values when the page uses `webview-lens/viewport`. `--overlay` draws
the same on the phone: a panel, a red line at the visible bottom, and the focused field outlined
green (visible), orange (partly) or red (hidden). `--frames` prints every frame of the animation.
The numbers come from the same `measureViewport` the library uses.

Measured with it on the test apps (Redmi Note 8 Pro, Android 11, WebView 157; iPhone 17 Pro,
iOS 26.6.1; 2026-11-26):

| Container                          | What happens                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Android, Kotlin, `adjustResize`    | The WebView shrinks 720 → 465 px; keyboard 255 px, covers 0 px. A field hidden behind the 72 px composer is scrolled up in 0.2 s.  |
| iOS, Flutter, WKWebView handles it | The visual viewport shrinks to 311 px and pans inside the 714 px layout; keyboard 369–403 px. Every field ends above the composer. |

What it found on the iPhone, all fixed in `webview-lens/viewport` and the Flutter recipe above: client
coordinates there follow the visual viewport, so a hidden field looked visible; `scrollIntoView`
centres in the layout viewport, part of which is under the keyboard; the page had no scroll room to
lift its last fields; `innerHeight` shrank by 34 px while a fixed bar's field was focused, and the bar
followed it under the keyboard.

## iOS zooms in when an input gets focus

Safari and WKWebView zoom into fields whose font is smaller than 16px. Keep inputs at 16px or more
(checked in the playground CSS):

```css
input,
textarea,
select {
    font-size: 16px;
}
```

## Notch, home indicator and status bar

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

```css
body {
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
        env(safe-area-inset-left);
}
```

## Sign the WebView in from the native app

Log in natively, then put the session on the stand's origin before loading the page. The web app
just sees a cookie, as in the browser (checked: Kotlin and Flutter).

```kotlin
// Kotlin: CookieManager needs a Looper thread for its callback, so do this on the UI thread.
runOnUiThread {
    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    cookies.setCookie(standUrl, "session=$token; Path=/; Secure; HttpOnly; SameSite=Lax") {
        cookies.flush()
        webView.loadUrl("$standUrl/")
    }
}
```

```dart
// Flutter
await WebViewCookieManager().setCookie(
  WebViewCookie(name: 'session', value: token, domain: Uri.parse(standUrl).host, path: '/'),
);
await controller.loadRequest(Uri.parse('$standUrl/'));
```

```swift
// Swift
let cookie = HTTPCookie(properties: [
    .name: "session", .value: token, .domain: standHost, .path: "/", .secure: "TRUE",
])!
webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
    webView.load(URLRequest(url: standURL))
}
```

Under `webview-lens dev` this cookie reaches your local dev server too.

## One JS bridge API on every platform

Give the page the same `window.NativeBridge.postMessage(json)` everywhere and answer through
`window.onNativeMessage(message)` (checked: Kotlin and Flutter).

```kotlin
// Kotlin
webView.addJavascriptInterface(object {
    @JavascriptInterface
    fun postMessage(json: String) { /* handle, then reply: */
        webView.post { webView.evaluateJavascript("window.onNativeMessage?.($reply)", null) }
    }
}, "NativeBridge")
```

```dart
// Flutter: a JavaScriptChannel named NativeBridge already has postMessage(string)
controller.addJavaScriptChannel('NativeBridge', onMessageReceived: (m) => handle(m.message));
controller.runJavaScript('window.onNativeMessage && window.onNativeMessage(${jsonEncode(reply)})');
```

```swift
// Swift: WKWebView exposes window.webkit.messageHandlers.<name>; add the same window.NativeBridge on top.
let shim = "window.NativeBridge = { postMessage: (m) => window.webkit.messageHandlers.NativeBridge.postMessage(m) };"
config.userContentController.addUserScript(
    WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
config.userContentController.add(handler, name: "NativeBridge")
// reply: webView.evaluateJavaScript("window.onNativeMessage && window.onNativeMessage(\(json))")
```

## Back button walks the page history

```kotlin
// Kotlin (checked)
override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
}
```

```dart
// Flutter (checked)
PopScope(
  canPop: false,
  onPopInvokedWithResult: (didPop, _) async {
    if (didPop) return;
    if (await controller.canGoBack()) return controller.goBack();
    if (context.mounted) Navigator.of(context).pop();
  },
  child: WebViewWidget(controller: controller),
)
```

## `<input type="file">` does nothing on Android

Android WebView only opens a picker when the app handles it:

```kotlin
private var fileCallback: ValueCallback<Array<Uri>>? = null

webView.webChromeClient = object : WebChromeClient() {
    override fun onShowFileChooser(
        view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
    ): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        startActivityForResult(params.createIntent(), FILE_REQUEST)
        return true
    }
}

override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != FILE_REQUEST) return super.onActivityResult(requestCode, resultCode, data)
    fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
    fileCallback = null
}
```

## HTTPS stand with a company CA in debug builds

Keep cleartext off and trust the stand's CA only in debug builds (checked):
`app/src/debug/res/xml/network_security_config.xml`

```xml
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/stand_ca" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

## Scripting webview-lens from your code

### Web Vitals budgets in CI

<!-- example: examples/recipes/ci-vitals.ts -->

```ts
// Lab Web Vitals in CI from your own script: measure, save the report, fail the job on budgets.
// Run: node examples/recipes/ci-vitals.ts   (a phone with the app open, USB debugging on)

import fs from 'node:fs';

import { checkBudgets, measureVitals, parseBudgets, resolveDriver, toMarkdown } from 'webview-lens';

export const runVitals = async () => {
    // 'auto' picks the connected platform; pass 'android' or 'ios' to pin it.
    const driver = await resolveDriver(process.env.PLATFORM === 'ios' ? 'ios' : 'auto');
    const result = await measureVitals({
        driver,
        paths: ['/', '/orders'],
        runs: 3,
        cold: true,
        // Progress and what blocks it ("No phone found: …") in the job log; the library is silent otherwise.
        log: console.log,
        // A job must not hang forever when the phone is not there.
        wait: { signal: AbortSignal.timeout(5 * 60_000) },
    });

    fs.writeFileSync('webview-vitals.md', toMarkdown(result));

    const violations = checkBudgets(result, parseBudgets('lcp=2500,cls=0.1,ttfb=800'));

    for (const v of violations) console.error(`✗ ${v.path} ${v.metric}: ${v.actual} > ${v.limit}`);
    process.exitCode = violations.length > 0 ? 1 : 0;
};
```

<!-- /example -->

### Page logs as JSON lines for your tooling (checked on Android)

<!-- example: examples/recipes/page-logs.ts -->

```ts
// The WebView page's console, exceptions and failed requests as JSON lines for your own tooling
// (log collector, test reporter), instead of `--logs` text in the terminal. Android shown here.
// Run: node examples/recipes/page-logs.ts

import { attachTelemetry, connectCdp, waitForPage } from 'webview-lens';

export const streamPageLogs = async (port = 9223) => {
    // Forwards the port to the app's WebView socket and waits until its page shows up.
    const page = await waitForPage(port, (p) => p.type === 'page' && p.url.startsWith('https://'));
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    const line = (kind: string) => (text: string) =>
        process.stdout.write(`${JSON.stringify({ kind, page: page.url, text })}\n`);

    attachTelemetry(cdp, {
        log: line('log'),
        error: line('error'),
        levels: ['log', 'warn', 'error'],
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.closed;
};
```

<!-- /example -->

### Reading protocol results without casts

`cdp.send()` and `cdp.on()` return `unknown`: the other end is a phone, a proxy or a page script, and a
type parameter would only claim a shape. Decode what you read. `sendDecoded` rejects with the method
name when the result has another shape; `subscribe` calls your listener only with params that decode.
The decoders webview-lens uses itself (`decodeCookies`, `decodeEvaluateResult`, …) and the building
blocks (`rec`, `str`, `num`, `list`, …) are exported.

<!-- example: examples/recipes/read-protocol.ts -->

```ts
// Reading DevTools protocol results without casts: `send` and `on` hand out `unknown`, decoders turn
// it into the fields you read (or `undefined`, if the page, the phone or a proxy sent another shape).
// Run: node examples/recipes/read-protocol.ts

import {
    connectCdp,
    decodeCookies,
    decodeEvaluateResult,
    type Decoder,
    num,
    rec,
    sendDecoded,
    str,
    subscribe,
    waitForPage,
} from 'webview-lens';

// Your own decoder for a command webview-lens does not cover.
const decodeLayout: Decoder<{ width: number; height: number }> = (input) => {
    const viewport = rec(rec(input)?.cssVisualViewport);
    const width = num(viewport?.clientWidth);
    const height = num(viewport?.clientHeight);

    return width !== undefined && height !== undefined ? { width, height } : undefined;
};

export const inspectPage = async (port = 9223) => {
    const page = await waitForPage(port, (p) => p.type === 'page' && p.url.startsWith('https://'));
    const cdp = await connectCdp(page.webSocketDebuggerUrl);

    // A result of another shape rejects with the method name instead of failing later on `undefined`.
    const cookies = await sendDecoded(
        cdp,
        'Network.getCookies',
        { urls: [page.url] },
        decodeCookies,
    );
    const layout = await sendDecoded(cdp, 'Page.getLayoutMetrics', {}, decodeLayout);
    const title = str(
        decodeEvaluateResult(
            await cdp.send('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            }),
        )?.value,
    );

    console.log({ title, cookies: cookies.map((c) => c.name), layout });

    // Events: the listener only sees params that decode.
    const off = subscribe(
        cdp,
        'Page.frameNavigated',
        (input) => str(rec(rec(input)?.frame)?.url),
        (url) => console.log('navigated to', url),
    );

    await cdp.send('Page.enable');
    await cdp.closed;
    off();
};
```

<!-- /example -->

### webview-lens' own logs in your logger

Library functions print nothing by themselves. Pass `log` (or `logger` for `startOverride` and the iOS
proxy) to see their progress, for example `measureVitals({ …, log: console.log })`. To see everything
without code changes, run your script with `WEBVIEW_LENS_DEBUG=1` (stderr) or
`WEBVIEW_LENS_LOG_FILE=wvl.jsonl`. To send it to your own logger:

<!-- example: examples/recipes/library-logs.ts -->

```ts
// What webview-lens itself does (adb calls, forwards, sockets, proxy decisions) inside your own app or
// test runner: send its log entries to your logger. The CLI does the same with --verbose / --log-file.

import { configureLogging, type LogEntry } from 'webview-lens';

/** Any logger with level methods: console, pino, winston… */
interface AppLogger {
    debug(message: string, data?: object): void;
    warn(message: string, data?: object): void;
    error(message: string, data?: object): void;
}

export const forwardLibraryLogs = (logger: AppLogger) =>
    configureLogging({
        file: '.webview-lens/run.jsonl', // also keep a JSON Lines file for bug reports
        sinks: [
            {
                level: 'debug',
                sink: (entry: LogEntry) => {
                    const method = entry.level === 'info' ? 'debug' : entry.level;

                    logger[method](`[webview-lens:${entry.scope}] ${entry.message}`, entry.data);
                },
            },
        ],
    }); // returns a function that turns it off again
```

<!-- /example -->
