# Проблемы WebView и решения

Что ломается у веб-страницы внутри Android WebView или iOS WKWebView, почему, и как это исправить с
webview-lens или без неё. Каждое решение проверено на реальном телефоне, если не сказано иначе
([как](verification.md)).

## WebView не видно в `chrome://inspect`

Android показывает только WebView тех приложений, которые включили отладку. В отладочной сборке:

| Приложение           | Переключатель                                                                           |
| -------------------- | --------------------------------------------------------------------------------------- |
| Android (Kotlin)     | `WebView.setWebContentsDebuggingEnabled(true)`                                          |
| Capacitor            | `webContentsDebuggingEnabled: true` в `capacitor.config`                                |
| React Native WebView | проп `webviewDebuggingEnabled`                                                          |
| Flutter              | `AndroidWebViewController.enableDebugging(true)`                                        |
| iOS 16.4+ (любое)    | `webView.isInspectable = true`; Flutter: `WebKitWebViewController.setInspectable(true)` |

Ещё нужны: отладка по USB на телефоне, разблокированный экран и приложение на экране с WebView.
`npx webview-lens doctor` проверяет всё это и называет первое, что не так.

## DevTools отключаются при каждом перезапуске приложения

Ссылка из `chrome://inspect` ведёт на конкретный экземпляр WebView; после перезапуска появляется
новый, и старая вкладка умирает. `npx webview-lens devtools` открывает Chrome DevTools на
`http://localhost:3300` и сам переподключается к новой странице: вкладка и точки останова остаются.
Если приложение держит несколько WebView (прошлый экран в стеке), выбирается та, что на экране.

## Отладка iOS WKWebView на Windows

Web Inspector из Safari работает только на Mac. `npx webview-lens devtools --platform ios` работает
на Windows и macOS: находит iPhone по USB (`usbmuxd` из Apple Devices или iTunes на Windows),
запускает `ios_webkit_debug_proxy` и переводит WebKit Inspector Protocol в Chrome DevTools, которые
открываются на `http://localhost:3300`. В приложении нужно `webView.isInspectable = true` (iOS
16.4+), на iPhone — Настройки → Safari → Дополнения → Веб-инспектор. По шагам:
[iOS на macOS и Windows](ios.md).

## Открыть локальный dev-сервер внутри приложения

Если направить приложение на `http://10.0.2.2:3000` или IP компьютера, ломается то, что вы хотите
проверить: HTTP без шифрования заблокирован (`ERR_CLEARTEXT_NOT_PERMITTED`), cookie сессии
привязана к настоящему домену, а CSP, OAuth и нативный мост ждут настоящий HTTPS-адрес.

`npx webview-lens dev http://localhost:3000` оставляет приложение на его HTTPS-адресе и отвечает на
запросы с вашего dev-сервера, с горячей перезагрузкой. На Android — через протокол DevTools, без
правок приложения; на iOS — через прокси, который перехватывает только ваш домен (iPhone один раз
доверяет локальному CA). Пути из `--bypass /api` по-прежнему идут на настоящий бэкенд. Приложениям
с серверным рендерингом (Next.js, Nuxt, SvelteKit, Angular) нужен `--forwarded` и пара настроек:
[SSR и SSG](ssr.md).

## Логи `console.log` из WebView в терминале

Добавьте `--logs` к `dev` или `devtools`: сообщения консоли с местом в исходниках, необработанные
исключения и запросы, которые упали или вернули 4xx/5xx, выводятся сразу. Чтобы отдавать их своим
инструментам в JSON Lines, см. [рецепты](recipes.md#логи-страницы-в-json-lines-для-ваших-инструментов-проверено-на-android).

## Клавиатура закрывает поле ввода в WebView

Android с `adjustResize` сжимает WebView; iOS WKWebView сохраняет размер, и сжимается только
видимая область, поэтому панель с `position: fixed; bottom: 0` и последние поля оказываются под
клавиатурой. `100vh` не следует ни за тем, ни за другим.

`webview-lens/viewport` всё это замеряет и выставляет CSS-переменные: `bottom: var(--wl-keyboard-inset)`
для закреплённых панелей, `padding-bottom: var(--wl-scroll-room)`, чтобы последние поля можно было
прокрутить над клавиатурой, а `keepFocusedInputVisible()` прокручивает поле в фокусе выше
клавиатуры и закреплённых панелей. Во Flutter на iOS ещё отдайте клавиатуру WKWebView. Код для
страницы, Kotlin, Flutter и Swift: [рецепты](recipes.md#клавиатура-закрывает-поле-или-нижнюю-панель).
Посмотреть, что клавиатура делает на вашем телефоне: `npx webview-lens keyboard --overlay`.

## `100vh` внутри WebView неправильный

`100vh` — это максимальная высота окна, а не та, что видит пользователь, и с клавиатурой он не
меняется. Используйте `100dvh`, где он поддерживается, или `var(--wl-viewport-height)` из
`webview-lens/viewport`, который следует за видимой областью на Android и iOS.

## iOS увеличивает страницу при фокусе на поле

WKWebView и Safari увеличивают поля со шрифтом меньше 16px. Держите поля ввода от 16px
([рецепты](recipes.md#ios-увеличивает-страницу-при-фокусе-на-поле)).

## Замерить Core Web Vitals внутри приложения

Lighthouse в Chrome на компьютере меряет другой браузер на другой машине. `npx webview-lens vitals /
/catalog --runs 5` открывает каждый экран в WebView приложения на телефоне и выдаёт медианы LCP,
FCP, CLS, INP и TTFB, долгие задачи и память JS в отчёте Markdown. `--budget lcp=2500,cls=0.1`
завершается с кодом 1 при превышении бюджета, для CI. На Android `--throttle` и `--cpu` имитируют
медленную сеть и устройство. На iOS CLS — `n/a`: WebKit не сообщает о сдвигах макета.

## Web Vitals реальных пользователей WebView-приложения

Аналитика обычно не отличает WebView от браузера. `webview-lens/rum` отправляет Web Vitals, свои
тайминги и ошибки JS с меткой `env: android-webview | ios-wkwebview | browser`, а
`webview-lens/rum/server` собирает из них p50/p75/p95 и отдаёт `/metrics` для Prometheus в любой
среде с Fetch API (Node, Edge, Bun, Deno, Workers). [RUM и Prometheus](rum.md).

## Страница с серверным рендерингом строит ссылки на localhost

Под `webview-lens dev` запрос приходит на SSR-сервер с `localhost`. С `--forwarded` он получает
ещё и `X-Forwarded-Host`, `X-Forwarded-Proto` и `Forwarded` с настоящим адресом, и абсолютные
ссылки, canonical и OAuth указывают куда нужно. Next.js, Nuxt, SvelteKit и Angular читают их
по-разному: [SSR и SSG](ssr.md).

## После деплоя приложение показывает старый HTML

Пререндеренную страницу без `Cache-Control`, но с `Last-Modified` WebView кэширует эвристически, и
приложение может показывать прошлую сборку. Отдавайте HTML с `Cache-Control: no-cache`
([SSR и SSG](ssr.md)).

## Работает ли с Capacitor, Cordova, Ionic, React Native и Flutter?

Да. Все они рисуют в Android WebView и iOS WKWebView; в отладочной сборке нужно разрешить отладку
WebView (см. первый раздел). Проверено на приложениях на Kotlin и Flutter; Capacitor, Cordova и
React Native используют те же WebView и переключатели.
