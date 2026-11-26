# Рецепты

Решения того, на что разработчики WebView натыкаются снова и снова: веб-часть и нативная (Kotlin,
Flutter, Swift), плюс скрипты, которые управляют webview-lens из вашего кода. Фрагменты с пометкой
**проверено** запускались в тестовых приложениях (Kotlin и Flutter, с нативным входом) на реальных
Android-телефоне и iPhone; остальные написаны по документации платформ.

## Клавиатура закрывает поле или нижнюю панель

В каждом контейнере клавиатура ведёт себя по-своему. Android с `adjustResize` уменьшает WebView;
iOS WKWebView его не трогает и уменьшает только visual viewport; `100vh` не следует ни за одним.
Панель с `position: fixed; bottom: 0` на iOS оказывается под клавиатурой, а на Android стоит правильно.

**Web** (проверено): `webview-lens/viewport` измеряет это и пишет CSS-переменные в `<html>`.

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
    bottom: var(--wl-keyboard-inset, 0px); /* iOS: высота клавиатуры; Android adjustResize: 0 */
}
.screen {
    height: var(--wl-viewport-height, 100dvh); /* вместо 100vh */
}
body {
    /* Даёт последним полям подняться над клавиатурой: WKWebView в приложении не добавляет под неё
       запас прокрутки (замерено), и без этого они остаются под ней. 0, если WebView сжался. */
    padding-bottom: var(--wl-scroll-room, 0px);
}
```

| Переменная / атрибут   | Что значит                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `--wl-keyboard-inset`  | часть страницы под клавиатурой: на столько поднимать закреплённые панели (0, если WebView сжался) |
| `--wl-keyboard-height` | высота клавиатуры (0, когда закрыта)                                                              |
| `--wl-viewport-height` | видимая высота                                                                                    |
| `--wl-scroll-room`     | запас в конце страницы, чтобы последние поля можно было прокрутить над клавиатуру                 |
| `data-wl-keyboard`     | `open` / `closed` на `<html>`                                                                     |

**Android (Kotlin).** Оставьте у activity `android:windowSoftInputMode="adjustResize"`. Приложения с
target SDK 35+ на Android 15+ работают edge-to-edge, и там `adjustResize` окно уже не уменьшает:
применяйте отступы клавиатуры и системных панелей сами (API 30+; ниже 30 — AndroidX `ViewCompat`).

```kotlin
webView.setOnApplyWindowInsetsListener { view, insets ->
    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
    WindowInsets.CONSUMED
}
```

**Flutter.** На Android оставьте `Scaffold(resizeToAvoidBottomInset: true)` по умолчанию:
`WebViewWidget` сжимается, `--wl-keyboard-inset` остаётся 0. На iOS выключите его и отдайте
клавиатуру WKWebView, а также запретите WKWebView добавлять безопасную зону к своим отступам (у
webview_flutter нет для этого Dart-API, нужно несколько строк Swift). Оба замерены на iPhone: со
сжатием WKWebView прокручивал новое поле по старой геометрии; с автоматическими отступами поле в
закреплённой панели уезжало под клавиатуру на 33 px.

```dart
Scaffold(resizeToAvoidBottomInset: !Platform.isIOS, body: WebViewWidget(controller: controller))

// после первой загрузки страницы (onPageFinished), только iOS:
const MethodChannel('app/webview_insets').invokeMethod<int>('neverAdjust');
```

```swift
// AppDelegate: на "neverAdjust" для каждого WKWebView в окнах приложения
webView.scrollView.contentInsetAdjustmentBehavior = .never
```

**iOS (Swift).** WKWebView не уменьшается; так и оставьте и используйте `--wl-keyboard-inset` на
странице. С `viewport-fit=cover` уберите двойные отступы: `webView.scrollView.contentInsetAdjustmentBehavior = .never`.

### Что делает клавиатура: `webview-lens keyboard`

```bash
npx webview-lens keyboard --overlay            # Android; для iPhone добавьте --platform ios
```

Строка на каждое изменение: высота клавиатуры, сколько страницы она перекрывает, видимая высота,
поле в фокусе (`visible`, `partly hidden`, `HIDDEN` и не закрыто ли оно закреплённой панелью, например
полем сообщения) и значения `--wl-*`, если страница использует `webview-lens/viewport`. `--overlay`
рисует то же на телефоне: панель, красную линию по видимому низу и обводку поля: зелёную (видно),
оранжевую (частично) или красную (скрыто). `--frames` печатает каждый кадр анимации. Цифры
считает тот же `measureViewport`, что и библиотека.

Замеры этим инструментом в тестовых приложениях (Redmi Note 8 Pro, Android 11, WebView 157;
iPhone 17 Pro, iOS 26.6.1; 2026-11-26):

| Контейнер                                     | Что происходит                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Android, Kotlin, `adjustResize`               | WebView сжимается 720 → 465 px; клавиатура 255 px, перекрывает 0 px. Поле за панелью (72 px) поднимается за 0,2 с.      |
| iOS, Flutter, клавиатурой управляет WKWebView | Видимая область сжимается до 311 px и сдвигается внутри 714 px; клавиатура 369–403 px. Каждое поле в итоге над панелью. |

Что инструмент нашёл на iPhone; всё исправлено в `webview-lens/viewport` и рецепте Flutter выше:
клиентские координаты там отсчитываются от видимой области, и скрытое поле казалось видимым;
`scrollIntoView` центрирует в layout viewport, часть которого под клавиатурой; странице не хватало
запаса прокрутки, чтобы поднять последние поля; `innerHeight` уменьшался на 34 px, пока в фокусе
поле закреплённой панели, и панель уходила вслед за ним под клавиатуру.

## iOS увеличивает страницу при фокусе на поле

Safari и WKWebView приближают поля со шрифтом меньше 16px. Держите поля ввода от 16px (проверено в CSS
стенда):

```css
input,
textarea,
select {
    font-size: 16px;
}
```

## Вырез, полоска «домой» и статус-бар

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

```css
body {
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
        env(safe-area-inset-left);
}
```

## Авторизовать WebView из нативного приложения

Войдите нативно, затем положите сессию на origin стенда до загрузки страницы. Веб-приложение просто
видит cookie, как в браузере (проверено: Kotlin и Flutter).

```kotlin
// Kotlin: колбэку CookieManager нужен поток с Looper, поэтому — в UI-потоке.
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

Под `webview-lens dev` эта cookie доходит и до вашего локального dev-сервера.

## Один API JS-bridge на всех платформах

Дайте странице одинаковый `window.NativeBridge.postMessage(json)` везде и отвечайте через
`window.onNativeMessage(message)` (проверено: Kotlin и Flutter).

```kotlin
// Kotlin
webView.addJavascriptInterface(object {
    @JavascriptInterface
    fun postMessage(json: String) { /* обработать и ответить: */
        webView.post { webView.evaluateJavascript("window.onNativeMessage?.($reply)", null) }
    }
}, "NativeBridge")
```

```dart
// Flutter: у JavaScriptChannel с именем NativeBridge уже есть postMessage(string)
controller.addJavaScriptChannel('NativeBridge', onMessageReceived: (m) => handle(m.message));
controller.runJavaScript('window.onNativeMessage && window.onNativeMessage(${jsonEncode(reply)})');
```

```swift
// Swift: WKWebView даёт window.webkit.messageHandlers.<name>; добавляем поверх тот же window.NativeBridge.
let shim = "window.NativeBridge = { postMessage: (m) => window.webkit.messageHandlers.NativeBridge.postMessage(m) };"
config.userContentController.addUserScript(
    WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
config.userContentController.add(handler, name: "NativeBridge")
// ответ: webView.evaluateJavaScript("window.onNativeMessage && window.onNativeMessage(\(json))")
```

## Кнопка «Назад» идёт по истории страницы

```kotlin
// Kotlin (проверено)
override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
}
```

```dart
// Flutter (проверено)
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

## `<input type="file">` на Android ничего не делает

Android WebView открывает выбор файла, только если приложение это обрабатывает:

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

## HTTPS-стенд с корпоративным CA в debug-сборках

Cleartext выключен, CA стенда доверяется только в debug-сборках (проверено):
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

## Управление webview-lens из вашего кода

### Бюджеты Web Vitals в CI

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

### Логи страницы в JSON Lines для ваших инструментов (проверено на Android)

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

### Ответы протокола без приведений типов

`cdp.send()` и `cdp.on()` возвращают `unknown`: на другом конце телефон, прокси или скрипт страницы, и
параметр типа лишь заявлял бы форму ответа. Разбирайте то, что читаете. `sendDecoded` отклоняется с
именем метода, если у ответа другая форма; `subscribe` вызывает слушателя только с параметрами,
которые разобрались. Экспортированы и декодеры, которыми пользуется сама webview-lens (`decodeCookies`,
`decodeEvaluateResult`, …), и базовые блоки (`rec`, `str`, `num`, `list`, …).

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

### Собственные логи webview-lens в вашем логгере

Функции библиотеки сами ничего не печатают. Исключение: `attachTelemetry` печатает консоль страницы в stdout / stderr, если не передать `log` / `error`; строки, залогированные до подключения, помечаются `(earlier)` (`earlier: 'skip'` их скрывает). Передайте `log` (или `logger` для `startOverride` и
iOS-прокси), чтобы видеть их прогресс, например `measureVitals({ …, log: console.log })`. Чтобы
увидеть всё без правки кода, запустите скрипт с `WEBVIEW_LENS_DEBUG=1` (stderr) или
`WEBVIEW_LENS_LOG_FILE=wvl.jsonl`. Чтобы отправить их в свой логгер:

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
