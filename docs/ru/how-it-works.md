# Как это работает

```text
Android телефон                            ПК (macOS / Windows / Linux)
┌──────────────────────────────┐           ┌────────────────────────────────────────────┐
│ app → WebView (https://stand)│           │ webview-lens                               │
│   @webview_devtools_remote_<pid> ◄──adb──┤   ├─ dev:      Fetch.requestPaused → local │
└──────────────────────────────┘           │   ├─ devtools: localhost:3300 → frontend   │
                                           │   ├─ vitals:   PerformanceObserver + CI    │
iPhone (WKWebView)                         │   └─ --logs:   console / exceptions / HTTP │
┌──────────────────────────────┐           │                                            │
│ app → WKWebView              │◄──usbmux──┤   ├─ devtools: localhost:3300 (WIP ↔ CDP)  │
│   Wi-Fi HTTP Proxy ─────────────────────►│   └─ dev:      selective HTTPS MITM proxy  │
└──────────────────────────────┘           └────────────────────────────────────────────┘
```

## Поиск Android WebView (`src/node/adb.ts`, `src/node/device.ts`)

1. Каждый отлаживаемый WebView открывает абстрактный unix-сокет `webview_devtools_remote_<pid>`. Список сокетов читается через `adb shell cat /proc/net/unix`.
2. Если WebView открыт сразу в нескольких приложениях (например, debug и release), приоритет получает приложение на экране (из `dumpsys window`: `mFocusedApp`, затем `mCurrentFocus`) или пакет, явно заданный через `--app`, сопоставленный с `ps -A -o PID,NAME`.
3. `adb forward tcp:9223 localabstract:<socket>`. После перезапуска приложения PID меняется, поэтому при пропаже страницы проброс автоматически пересоздаётся. Параллельно CLI выводит понятную подсказку о блокирующей проблеме (нет телефона, не подтверждена отладка, заблокирован экран, нет debuggable WebView).

## Локальная подмена на Android (`src/node/override.ts`)

- `Fetch.enable` перехватывает запросы к origin стенда (с поддержкой subpath `--remote-base` / `--local-base` и обхода `--bypass`). Каждый запрос перенаправляется на локальный dev-сервер с куками стенда (`Network.getCookies`), перезаписью `Origin` и `Referer` и удалением hop-by-hop заголовков (RFC 9110 §7.6.1). Заголовки `Location` мапятся обратно на домен стенда, `Set-Cookie` прокидываются в WebView.
- Для `text/event-stream` (SSE) поток немедленно отменяется, чтобы не вешать CDP `Fetch`.
- WebSocket (HMR) не перехватывается доменом `Fetch`, поэтому `Page.addScriptToEvaluateOnNewDocument` устанавливает прокси `WebSocket`, пересылающий фреймы через `Runtime.addBinding` (включая отдельные HMR-порты `--hmr-port`, обходя Mixed Content).

## Постоянный адрес DevTools (`src/node/devtools-frontend.ts`, `src/node/devtools-link.ts`)

- `/` редиректит на `/serve_rev/@<revision>/inspector.html?ws=localhost:3300/devtools/page/<id>`. Ревизия берётся из `devtoolsFrontendUrl` или `WebKit-Version`.
- Файлы `/serve_rev/*` один раз загружаются с `chrome-devtools-frontend.appspot.com` (или зеркала `DEVTOOLS_FRONTEND_ORIGIN`), из HTML вырезается блокирующий `<meta http-equiv="Content-Security-Policy">`, и файлы кешируются в памяти.
- `upgrade /devtools/*` проксируется сырым TCP на проброшенный порт без заголовка `Origin`.

## Лабораторные Web Vitals (`src/node/vitals-lab.ts`)

Перед скриптами приложения внедряется коллектор, собирающий LCP (с DOM-элементом), FCP, CLS (сессионные окна: разрыв < 1 с, окно < 5 с), INP, TTFB, Long Tasks и `performance.mark`. На Android дополнительно снимается `JSHeapUsedSize` (`Performance.getMetrics`) и поддерживается эмуляция сети/CPU (`--throttle`, `--cpu`). По итогам N прогонов считаются медианы и проверяются CI-бюджеты (`--budget`).

## iOS WKWebView (`src/node/drivers/ios/*`)

- **USB discovery (`usbmux.ts`)**: общается напрямую по протоколу v1 XML plist с `/var/run/usbmuxd` (macOS/Linux) или `127.0.0.1:27015` (Apple Mobile Device Support на Windows).
- **Инспектор и DevTools (`iwdp.ts`, `wip-cdp-bridge.ts`, `devtools-bridge.ts`)**: находит или сам запускает `ios_webkit_debug_proxy`, поднимает локальный RFC 6455 WebSocket-сервер (`src/node/ws-server.ts`) и двунаправленно транслирует CDP ↔ WebKit Inspector Protocol (WIP).
- **Selective HTTPS MITM (`certs.ts`, `mitm-proxy.ts`)**: генерирует локальный ECDSA P-256 X.509 v3 Root CA и SAN leaf-сертификаты без `openssl` и внешних пакетов, отдаёт профиль `.mobileconfig` с QR-кодом в терминале (`src/node/qr.ts`) и перехватывает только целевой хост `--remote` (HTTP + нативный WebSocket HMR), пропуская остальной трафик сырым TCP `CONNECT`.

## RUM (`src/rum`)

- Клиент отправляет компактный JSON через `navigator.sendBeacon` (с fallback на `fetch(..., { keepalive: true })`), чтобы финальные CLS и INP не терялись при закрытии WebView.
- Серверные хендлеры используют только Web Fetch API (`Request`, `Response`, `ReadableStream`) со стриминговым лимитом размера тела, адаптером `toNodeHandler`, ограниченным по памяти агрегатором (`src/rum/aggregator.ts`) и экспортом в Prometheus `/metrics`.
