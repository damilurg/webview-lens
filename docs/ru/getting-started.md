# Быстрый старт

От `npm install` до DevTools, локального dev-сервера и Web Vitals внутри настоящего приложения, на
Android и iOS. На каждом шаге сказано, что вы должны увидеть, чтобы было понятно, где вы.

## 1. Установка

```bash
npm i -D webview-lens     # Node.js 22.4+; больше ничего не ставится
npx webview-lens init     # создаёт webview-lens.config.json под ваш сборщик (необязательно)
```

## 2. Сделайте WebView приложения отлаживаемым (тестовые сборки)

| Стек                      | Android                                                     | iOS (16.4+)                                                             |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Нативный (Kotlin / Swift) | `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` | `webView.isInspectable = true`                                          |
| Flutter `webview_flutter` | `AndroidWebViewController.enableDebugging(true)`            | `(controller.platform as WebKitWebViewController).setInspectable(true)` |
| React Native WebView      | проп `webviewDebuggingEnabled`                              | проп `webviewDebuggingEnabled`                                          |
| Capacitor / Cordova       | включено в debug-сборках                                    | включено в debug-сборках                                                |

Без этого WebView нигде не появится; `doctor` об этом скажет.

## 3. Android

1. Телефон: **Настройки → О телефоне → 7 раз нажать на номер сборки**, затем **Для разработчиков →
   Отладка по USB**. На Xiaomi / MIUI ещё **Установка через USB** и **Отладка по USB (настройки безопасности)**.
2. Подключите кабель, разрешите компьютер на телефоне, откройте экран с WebView.
3. Проверьте:

```bash
npx webview-lens doctor
```

Должно быть `✓ phone connected`, `✓ app on screen: <ваш пакет>` и `✓ debuggable WebViews: …`.
`adb` находится сам (Android SDK, `ANDROID_HOME`, `PATH`, `~/Downloads`); если он в другом месте, задайте `ADB`.

4. Работайте:

```bash
npx webview-lens devtools --logs                                  # DevTools на http://localhost:3300
npx webview-lens dev http://localhost:5173 --remote https://stand.example.com
npx webview-lens vitals / /catalog --runs 3 --budget lcp=2500
```

`dev` оставляет WebView на HTTPS-домене стенда и отвечает на его запросы вашим dev-сервером: на
странице ваш локальный код, с cookies стенда и настоящим нативным bridge.

## 4. iOS (macOS и Windows)

1. Компьютер: `ios_webkit_debug_proxy` (`brew install ios-webkit-debug-proxy`, на Windows — Scoop), на
   Windows ещё Apple Devices или iTunes. webview-lens запускает прокси сам.
2. iPhone: **Настройки → Safari → Дополнения → Веб-инспектор**. Подключите кабель, нажмите **Доверять**.
3. Проверьте и работайте:

```bash
npx webview-lens doctor --platform ios
npx webview-lens devtools --platform ios --logs                   # Chrome DevTools для WKWebView
npx webview-lens vitals / --platform ios
```

4. Локальный dev-сервер внутри iOS-приложения идёт через Wi-Fi-прокси на компьютере:
   `npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com`, затем
   восемь шагов из [настройки iOS](ios.md#как-работает-прокси-по-шагам) (прокси проверяет себя сам:
   **Proxy: OK**, **Interception: OK**).

С несколькими устройствами сразу запускайте по процессу webview-lens на устройство: см. README.

## 5. Переменные окружения

| Переменная                         | Что задаёт                                                  | По умолчанию                           |
| ---------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `ADB`                              | путь к `adb`                                                | ищется в Android SDK, PATH…            |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | где Android SDK (для `adb`)                                 | `~/Library/Android/sdk` и др.          |
| `ANDROID_SERIAL`                   | какой Android-телефон, если их несколько (`--serial`)       | единственный                           |
| `DEVTOOLS_PORT`                    | локальный порт к DevTools-сокету WebView (`--port`)         | `9223`                                 |
| `DEVTOOLS_LINK_PORT`               | постоянный адрес DevTools (`--link-port`)                   | `3300`                                 |
| `LOCAL_URL`                        | локальный dev-сервер для `dev`                              | `http://localhost:3000`                |
| `IWDP`, `IOS_WEBKIT_DEBUG_PROXY`   | путь к `ios_webkit_debug_proxy`                             | PATH, Homebrew, Scoop                  |
| `DEVTOOLS_FRONTEND_ORIGIN`         | зеркало фронтенда Chrome DevTools (корпоративные сети)      | `chrome-devtools-frontend.appspot.com` |
| `WEBVIEW_LENS_DEVTOOLS_REVISION`   | ревизия фронтенда DevTools для iOS                          | проверенная ревизия                    |
| `WEBVIEW_LENS_DEBUG=1`             | что делает сам webview-lens, в stderr (`--verbose`)         | выкл.                                  |
| `WEBVIEW_LENS_LOG_FILE`            | то же в JSON Lines в файл (`--log-file`)                    | выкл.                                  |
| `NODE_EXTRA_CA_CERTS`              | доверять стенду с частным CA для запросов `--bypass` (Node) | системные CA                           |

## 6. Конфиг проекта (`webview-lens.config.json`)

Флаги важнее конфига. Все ключи необязательные и проверяются при запуске.

```json
{
    "platform": "auto",
    "preset": "vite",
    "local": "http://localhost:5173",
    "remote": "https://stand.example.com",
    "cmd": "npm run dev",
    "bypass": ["/api"],
    "logs": true,
    "app": "com.example.app.debug",
    "budget": "lcp=2500,cls=0.1"
}
```

## 7. Если что-то не работает

1. `npx webview-lens doctor` (для iOS с `--platform ios`): первая строка с ✗ и есть проблема.
2. Добавьте к любой команде `--verbose`: каждый вызов adb, port forward, сокет и решение прокси в stderr.
   `--log-file run.jsonl` сохранит это в файл для баг-репорта.
3. iOS-прокси: [таблица «симптом → причина → что сделать»](ios.md#если-не-работает).

Дальше: [Рецепты](recipes.md) — клавиатура, safe areas, авторизация WebView, нативный bridge и
управление webview-lens из вашего кода.
