# Отладка веб-страницы внутри мобильного приложения

Ваше веб-приложение живёт в Android WebView или iOS WKWebView, и ломается именно там: cookie от
нативного входа, JS-мост, клавиатура, HTTPS-адрес приложения. В Chrome на компьютере ничего этого
нет. `chrome://inspect` теряет страницу при каждом перезапуске приложения, инспектору Safari нужен
Mac, приложение не открывает ваш `localhost`, а логи остаются на телефоне.

webview-lens — это консольная утилита и три небольших модуля для страницы. Работает с macOS, Windows
и Linux, телефон Android или iPhone подключается по USB.

```bash
npm i -D webview-lens
npx webview-lens doctor        # чего не хватает на компьютере и на телефоне
```

## Что умеет

| Команда                                  | Что получаете                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `webview-lens devtools`                  | Chrome DevTools для страницы приложения на `http://localhost:3300`. Не отваливаются при перезапуске приложения. iPhone тоже. |
| `webview-lens dev http://localhost:5173` | Приложение открывает ваш dev-сервер под своим настоящим HTTPS-адресом: горячая перезагрузка, cookie сессии и мост работают.  |
| `--logs`                                 | `console.log`, необработанные ошибки и упавшие запросы страницы прямо в терминале.                                           |
| `webview-lens vitals /`                  | LCP, FCP, CLS, INP и TTFB, замеренные на телефоне, отчёт в Markdown и ненулевой код выхода при превышении бюджета для CI.    |
| `webview-lens keyboard --overlay`        | Что экранная клавиатура делает со страницей: высота, что перекрыто, скрыто ли поле в фокусе.                                 |

И для самой страницы: `webview-lens/viewport` держит закреплённые панели и поле в фокусе над
клавиатурой на обеих платформах, а `webview-lens/rum` отправляет Web Vitals реальных пользователей
на ваш сервер с меткой контейнера (`android-webview`, `ios-wkwebview`, `browser`) и отдаёт их в
Prometheus.

## Когда это нужно

- [WebView не видно в `chrome://inspect`](troubleshooting.md#webview-не-видно-в-chrome-inspect)
- [DevTools отключаются при каждом перезапуске приложения](troubleshooting.md#devtools-отключаются-при-каждом-перезапуске-приложения)
- [Нужно отлаживать iOS WebView на Windows](troubleshooting.md#отладка-ios-wkwebview-на-windows)
- [Приложение должно открыть ваш localhost](troubleshooting.md#открыть-локальныи-dev-сервер-внутри-приложения)
- [Клавиатура закрывает поле ввода в WebView](troubleshooting.md#клавиатура-закрывает-поле-ввода-в-webview)
- [Нужны Web Vitals изнутри приложения, а не из Chrome на компьютере](troubleshooting.md#замерить-core-web-vitals-внутри-приложения)

Все проблемы и решения: [Проблемы WebView](troubleshooting.md). Чем отличается от
`chrome://inspect`, Safari Web Inspector, Eruda и HTTP-прокси: [Альтернативы](alternatives.md).

## Попробовать на Android за две минуты

1. Включите отладку по USB на телефоне и подключите его.
2. В отладочной сборке приложения включите отладку WebView:
   `WebView.setWebContentsDebuggingEnabled(true)`. У Capacitor, React Native WebView и Flutter свой
   переключатель, см. [Быстрый старт](getting-started.md).
3. Откройте экран с WebView и запустите:

```bash
npx webview-lens devtools --logs
```

Откройте `http://localhost:3300` в Chrome. Для iPhone добавьте `--platform ios`; шаги описаны в
[iOS на macOS и Windows](ios.md).

## Проверено на реальных телефонах

Каждая функция на этом сайте запускалась на Redmi Note 8 Pro (Android 11) и iPhone 17 Pro
(iOS 26.6.1), в приложениях на Kotlin и Flutter с нативным входом, с Vite, Next.js 16, Nuxt 4,
SvelteKit 3 и Angular 22. Что проверено, что замерено и что нашлось на телефонах — на странице
[Как проверено](verification.md).

Работает с любым приложением, где есть WebView: нативные Android и iOS, Capacitor, Cordova, Ionic,
React Native WebView и Flutter. Лицензия MIT, без зависимостей во время выполнения.
