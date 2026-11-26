<div align="center">

# webview-lens

[![npm version](https://img.shields.io/npm/v/webview-lens?logo=npm&color=cb3837)](https://www.npmjs.com/package/webview-lens)
[![npm downloads](https://img.shields.io/npm/dm/webview-lens?logo=npm)](https://www.npmjs.com/package/webview-lens)
[![CI](https://github.com/damilurg/webview-lens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/damilurg/webview-lens/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/damilurg/webview-lens?logo=github)](https://github.com/damilurg/webview-lens/releases/latest)
[![npm provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=sigstore&logoColor=white)](https://www.npmjs.com/package/webview-lens#provenance)
<br>
[![node](https://img.shields.io/node/v/webview-lens?logo=nodedotjs&logoColor=white)](https://www.npmjs.com/package/webview-lens)
[![types](https://img.shields.io/npm/types/webview-lens?logo=typescript&logoColor=white)](https://www.npmjs.com/package/webview-lens)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/webview-lens?activeTab=dependencies)
[![platforms](https://img.shields.io/badge/WebView-Android%20%7C%20iOS-6f42c1)](https://github.com/damilurg/webview-lens/blob/main/docs/ios.md)
[![license](https://img.shields.io/npm/l/webview-lens)](https://github.com/damilurg/webview-lens/blob/main/LICENSE)

**[Сайт](https://damilurg.github.io/webview-lens/ru/)** · [Быстрый старт](getting-started.md) · [Рецепты](recipes.md) · [Настройка iOS](ios.md) · [SSR и SSG](ssr.md) · [RUM](rum.md) · [npm](https://www.npmjs.com/package/webview-lens) · [Changelog](../../CHANGELOG.md) · [Сообщить об ошибке](https://github.com/damilurg/webview-lens/issues/new)

[English](../../README.md) | **Русский**

</div>

**Отладка, подмена кода и замеры веб-страницы внутри нативного приложения.** `webview-lens`
открывает полноценные **Chrome DevTools для Android WebView и iOS WKWebView** на постоянном адресе
`http://localhost:3300` с **macOS, Windows или Linux**, в том числе отладку iOS на Windows. Он
загружает **ваш локальный dev-сервер внутри приложения** поверх настоящего HTTPS-домена, выводит
`console.log` из WebView в терминал, замеряет **Core Web Vitals на реальном телефоне** с бюджетами для
CI и даёт **RUM + Prometheus** для продакшена. **Ноль runtime-зависимостей.**

Страница внутри нативного WebView отличается от десктопного браузера: там есть нативный JS-bridge,
куки и User-Agent от приложения, тема/локаль и запрет на незашифрованный `http://`. `webview-lens`
позволяет запускать локальный dev-сервер (Vite, Next.js, Nuxt, SvelteKit, Angular, Webpack или любой
другой) поверх настоящего HTTPS-домена стенда без правок нативного или веб-кода.

**Работает с любым приложением, где есть WebView:** нативные Android (Kotlin/Java) и iOS
(Swift/Objective-C), Capacitor, Cordova / Ionic, React Native WebView, Flutter `webview_flutter`,
встроенные браузеры супер-приложений, если в тестовой сборке включена отладка WebView.

| Компонент                 | Назначение                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webview-lens init`       | Определяет сборщик (`next`, `nuxt`, `sveltekit`, `angular`, `vite`, `webpack`) и создаёт `webview-lens.config.json`                                                                                    |
| `webview-lens dev`        | Подменяет HTTPS-домен стенда вашим локальным dev-сервером (Android: CDP `Fetch`; iOS: selective HTTPS MITM) с HMR и `--logs`                                                                           |
| `webview-lens devtools`   | Полноценный Chrome DevTools на **постоянном** `http://localhost:3300` (переживает перезапуски приложения; на iOS работает через WIP ↔ CDP мост на Windows и macOS)                                     |
| `webview-lens cert`       | Генерирует локальный X.509 v3 Root CA и выводит QR-код в терминал для установки `.mobileconfig` на тестовый iPhone                                                                                     |
| `webview-lens vitals`     | Лабораторные LCP, FCP, CLS, INP, TTFB, Long Tasks, JS Heap и `performance.mark` на реальном телефоне + `--throttle`, `--cpu` и CI-флаг `--budget`                                                      |
| `webview-lens doctor`     | Пошаговая диагностика подключения (`adb`, `usbmuxd`, `ios_webkit_debug_proxy`, экран блокировки, доступные WebView)                                                                                    |
| `webview-lens keyboard`   | Клавиатура страницы в WebView в реальном времени: высота, сколько страницы перекрыто, скрыто ли поле в фокусе, значения `--wl-*`; `--overlay` рисует это на телефоне                                   |
| `webview-lens/rum`        | Браузерный клиент (0 `node:*` импортов): Web Vitals, кастомные тайминги, глобальные ошибки, `detectWebViewEnv`, контекстные теги                                                                       |
| `webview-lens/rum/server` | Edge-safe Fetch API хендлеры (`Request → Response`), адаптер `toNodeHandler` для Express/NestJS, агрегатор `createRumAggregator` (`p50`/`p75`/`p95`) и Prometheus `/metrics`                           |
| `webview-lens/viewport`   | Браузерные помощники для экранной клавиатуры: CSS-переменные `--wl-keyboard-inset`, `--wl-viewport-height`, `--wl-scroll-room` и поле в фокусе над клавиатурой и закреплёнными панелями, Android и iOS |
| `--verbose`, `--log-file` | Что делает сам webview-lens (вызовы adb, port forward, сокеты, решения прокси), в stderr или в JSON Lines; консоль страницы остаётся в DevTools                                                        |

**Как проверено:** каждое утверждение с телефонами, приложениями, командами, замерами и тестом, который его охраняет: [verification.md](verification.md).

## Требования

| Компонент                        | Минимум                                                                                            | Примечания                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js для CLI                  | **22.4**                                                                                           | Проверяется в CI на **22, 24 и 26** (Linux, macOS, Windows). Node 20 не поддерживается: нет глобального `WebSocket`, EOL.                                     |
| Node.js для разработки проекта   | **22.18**                                                                                          | Тесты запускают `.ts` напрямую; `.nvmrc` указывает 26.                                                                                                        |
| `webview-lens/rum` (на странице) | **Chrome / Android WebView 80**, **Safari / iOS 13.4**                                             | Синтаксис ES2020; сборщик может транспилировать ниже.                                                                                                         |
| `webview-lens/rum/server`        | любая среда с Fetch API                                                                            | Node 18+, Edge, Bun, Deno, Cloudflare Workers.                                                                                                                |
| `adb`                            | Android platform-tools с `adb reverse`                                                             | Ищется автоматически в `ADB`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, Android SDK, `PATH` и `~/Downloads`.                                                        |
| Android                          | **5.0** (API 21)                                                                                   | `adb reverse` (для `--hmr-port`) требует 5.0; старый `ps` в Android 5–7 поддерживается.                                                                       |
| Android System WebView / Chrome  | `devtools`: любой отлаживаемый WebView · `dev`: **80** · `vitals`: **77** (LCP, CLS), **96** (INP) | CDP `Fetch` (74+) и внедряемый мост WebSocket (80+). На Android 7+ WebView обновляется через Google Play.                                                     |
| iOS                              | **16.4** с `webView.isInspectable = true`                                                          | На более старых iOS инспектировать можно только development-сборки, запущенные из Xcode. `dev` (MITM) работает на любой iOS, доверяющей пользовательскому CA. |
| Компьютер                        | macOS, Windows 10/11, Linux                                                                        | iOS: macOS и Windows (Apple Devices или iTunes, `ios_webkit_debug_proxy`).                                                                                    |
| Фронтенд                         | любой фреймворк или обычный HTML                                                                   | Пресеты для Next.js, Nuxt, SvelteKit, Angular, Vite, Webpack.                                                                                                 |

Версии Node.js проверяются в CI. Минимумы на стороне телефона следуют из возможностей протоколов и
браузерных API, которые использует `webview-lens`.

**Настройка телефона:**

- **Android:** включена отладка по USB, тестовая сборка вызывает `WebView.setWebContentsDebuggingEnabled(true)`.
- **iOS (macOS и Windows):** в тестовой сборке выставлено `webView.isInspectable = true`, на iPhone включён _Настройки → Safari → Дополнительно → Веб-инспектор_. Для `devtools`/`vitals`/`--logs` нужен `ios_webkit_debug_proxy` (запускается автоматически) и Apple Devices / iTunes на Windows. Подробнее: [docs/ru/ios.md](ios.md).

## Быстрый старт

```bash
npm i -D webview-lens
npx webview-lens init --remote https://stand.example.com
npx webview-lens doctor
npx webview-lens dev
```

Пакет также зеркалируется в [GitHub Packages](https://github.com/damilurg/webview-lens/pkgs/npm/webview-lens) как `@damilurg/webview-lens` (нужны `@damilurg:registry=https://npm.pkg.github.com` в `.npmrc` и GitHub-токен с правом `read:packages`).

## Локальный dev-сервер внутри нативного приложения

```bash
# Android (автоопределение Vite / Next.js / Webpack / Nuxt / Angular)
npx webview-lens dev http://localhost:5173 --cmd "npm run dev" --logs

# iOS (macOS или Windows — предварительно один раз выполните `npx webview-lens cert`)
npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com --cmd "npm run dev" --logs
```

Основные опции (можно зафиксировать в `webview-lens.config.json` или указать через `--config <file>`):

- `--platform auto|android|ios` — выбор платформы (`auto` сам подхватит подключённый телефон).
- `--preset auto|next|nuxt|sveltekit|angular|vite|webpack|generic` — пресеты HMR WebSocket и фильтрации шума статики.
- `--forwarded` — отправляет SSR-серверу `X-Forwarded-Host/Proto` стенда, чтобы абсолютные URL, canonical и OAuth-колбэки указывали на стенд. Работает с SSR dev-серверами, production-сборками и статикой (SSG): см. [docs/ru/ssr.md](ssr.md).
- `--remote <url>` — origin стенда для подмены (на Android определяется автоматически по открытому WebView; на iOS обязателен).
- `--remote-base /shop` и `--local-base /` — маппинг subpath стенда на корень локального сервера (с перезаписью URL, `Referer` и `Location`).
- `--ws <prefix>` — префиксы WebSocket для моста через CDP на Android (повторяемый флаг).
- `--hmr-port <n>` — мост для отдельного порта HMR (Vite/Webpack) поверх CDP + автоматический `adb reverse`.
- `--quiet <prefix>` — скрытие шумных статических путей из лога; `--bypass <prefix>` — пропуск путей напрямую на стенд.
- `--sse fail|continue` — защита от зависания CDP `Fetch` на бесконечных `text/event-stream` ответах.
- `--logs` — стриминг `console.*`, необработанных исключений (1-based `path:line:col`) и 4xx/5xx / упавших сетевых запросов прямо в терминал.
- `--serial <id>` (или `ANDROID_SERIAL`) — выбор конкретного устройства; `--app <package>` — закрепление за нужным Android-пакетом.
- **Enter** перезагружает страницу на Android. **Ctrl+C** завершает работу и останавливает сервер, запущенный через `--cmd`.

## Несколько устройств одновременно

Один процесс `webview-lens` обслуживает одно устройство: запускайте по процессу на устройство, со
своими портами. Локальный dev-сервер общий: все телефоны получают ваш код, и одна правка
перезагружает их все по HMR (проверено на Android-телефоне и iPhone одновременно).

| Устройства       | Запуск                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Android + iPhone | `dev --platform android --link-port 3300 …` и `dev --platform ios --serial <udid> …` в двух терминалах                  |
| Два Android      | `--serial A --port 9223 --link-port 3300` и `--serial B --port 9224 --link-port 3301`                                   |
| Два iPhone       | `--serial A --link-port 3300` и `--serial B --link-port 3301`; для `dev` оба iPhone могут ходить через один MITM-прокси |

С двумя iPhone запустите `ios_webkit_debug_proxy` сами в отдельном терминале: прокси, который запустил
`webview-lens`, останавливается вместе с этим процессом, и второй процесс потеряет свой iPhone.

## DevTools на постоянном адресе

```bash
npx webview-lens devtools --logs
npx webview-lens devtools --platform ios --logs
```

Открывает Chrome DevTools на `http://localhost:3300` — закладка не ломается после перезапуска приложения и смены PID/pageId. На iOS встроенный RFC 6455 WebSocket-мост переводит WebKit Inspector Protocol (WIP) ↔ Chrome DevTools Protocol (CDP), поэтому Chrome DevTools работает одинаково и на Windows, и на macOS. Для корпоративных сетей за VPN можно указать зеркало через переменную `DEVTOOLS_FRONTEND_ORIGIN`.

## Лабораторные Web Vitals и CI-бюджеты

```bash
npx webview-lens vitals / /events "/event/42" \
  --runs 3 --cold --throttle slow-4g --cpu 4 \
  --budget lcp=2500,cls=0.1 \
  --out reports/vitals.md
```

- Снимает медианы **LCP** (с DOM-элементом), **FCP**, **CLS** (со сдвигами ≥ 0.01), **INP** (при `--interact <s>`), **TTFB**, **Long Tasks**, **JS Heap** (Android) и кастомные `performance.mark`.
- При превышении любого порога `--budget` завершается с кодом выхода `1` — готово для CI и ферм устройств.
- На iOS WKWebView неподдерживаемые движком WebKit метрики честно помечаются как `n/a`.
- Для реальных цифр замеряйте production-сборку (`npm run build && npm start`), а не dev-сервер.

## Продакшен-RUM и Prometheus

### Клиент (`webview-lens/rum`)

<!-- example: examples/rum/client.js -->

```js
import {
    captureGlobalErrors,
    createErrorReporter,
    createTimingReporter,
    createVitalsReporter,
    detectWebViewEnv,
} from 'webview-lens/rum';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

const context = () => ({ env: detectWebViewEnv(), release: '1.4.0' });
const report = createVitalsReporter({
    endpoint: '/api/vitals',
    path: () => '/event/:id', // supports both :param and [param]
    sampleRate: 1, // lower it in production, e.g. 0.5
    context,
});
[onCLS, onINP, onLCP, onFCP, onTTFB].forEach((on) => on(report));

export const reportTiming = createTimingReporter({ endpoint: '/api/timings', context });
captureGlobalErrors(createErrorReporter({ endpoint: '/api/client-log', context }));
```

<!-- /example -->

### Сервер (`webview-lens/rum/server`)

Работает нативно в Fetch API средах (Next.js App Router, Hono, Bun, Deno, Cloudflare Workers) и в Express / NestJS / `node:http` через `toNodeHandler`:

<!-- example: examples/rum/server.ts -->

```ts
import http from 'node:http';

import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from 'webview-lens/rum/server';

const rum = createRumAggregator({ maxSamplesPerSeries: 1000, maxSeries: 200 });

const routes: Record<string, ReturnType<typeof toNodeHandler>> = {
    '/api/vitals': toNodeHandler(createVitalsHandler({ onMetric: (m) => rum.recordVital(m) })),
    '/api/timings': toNodeHandler(createTimingsHandler({ onTiming: (t) => rum.recordTiming(t) })),
    '/api/client-log': toNodeHandler(createClientLogHandler({ onLog: (e) => rum.recordError(e) })),
    '/metrics': toNodeHandler(createMetricsHandler(rum)), // Prometheus 0.0.4
};

export const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? '/', 'http://localhost').pathname];

    if (route) return void route(req, res);
    res.writeHead(404).end();
});
```

<!-- /example -->

### Демо

Два фрагмента выше — это [`examples/rum/client.js`](../../examples/rum/client.js) и [`examples/rum/server.ts`](../../examples/rum/server.ts), их копирует в README `npm run examples:sync` (CI падает, если они разошлись). Запуск целиком:

```bash
npm run demo:rum   # выведет адрес (3000 или следующий свободный порт; PORT=… чтобы задать)
```

## Программный API и бенчмарки

Все модули CLI экспортируются из `webview-lens` (`createAndroidDriver`, `createIosDriver`, `resolveDriver`, `startOverride`, `startIosMitmProxy`, `startDevtoolsLink`, `startIosDevtoolsLink`, `measureVitals`, `parseBudgets`, `checkBudgets`, `renderQrTerminal`, `loadProjectConfig` и др.).

Запуск тестов (unit + BDD + ISO/RFC + инварианты) и микробенчмарков:

```bash
npm run verify
npm run bench
```

## Частые вопросы

### Как отладить WebView на Android без `chrome://inspect`?

Запустите `npx webview-lens devtools` и откройте в Chrome `http://localhost:3300`. Это те же Chrome
DevTools, но на адресе, который не меняется при перезапуске приложения (ссылка из `chrome://inspect`
меняется), и в обычной вкладке, которую можно добавить в закладки. Сборка приложения должна вызывать
`WebView.setWebContentsDebuggingEnabled(true)`.

### Как отлаживать iOS WKWebView или Safari на Windows?

`webview-lens devtools --platform ios` работает на Windows и macOS: находит iPhone по USB
(`usbmuxd` из Apple Devices / iTunes), запускает `ios_webkit_debug_proxy` и переводит WebKit
Inspector Protocol в Chrome DevTools, так что отладка идёт в Chrome на `http://localhost:3300`.
Приложение должно выставлять `webView.isInspectable = true` (iOS 16.4+). См. [docs/ru/ios.md](ios.md).

### Как открыть локальный dev-сервер (localhost) внутри WebView мобильного приложения?

`npx webview-lens dev http://localhost:3000`. WebView остаётся на HTTPS-домене стенда (без
`ERR_CLEARTEXT_NOT_PERMITTED` и без правок приложения), а на каждый запрос к этому домену отвечает
ваш локальный сервер, с HMR. На Android это Chrome DevTools Protocol `Fetch`, на iOS — HTTPS-прокси,
который перехватывает только хост стенда.

### Как видеть `console.log` и ошибки WebView в терминале?

Добавьте `--logs` к `dev` или `devtools`: сообщения консоли, необработанные исключения с местом в
исходнике и упавшие или 4xx/5xx сетевые запросы выводятся сразу.

### Как замерить Core Web Vitals внутри WebView и ронять CI при регрессиях?

`npx webview-lens vitals / /catalog --runs 5 --budget lcp=2500,cls=0.1` замеряет LCP, FCP, CLS, INP,
TTFB, Long Tasks и JS heap на реальном телефоне, пишет отчёт в Markdown и завершается с кодом 1, если
бюджет превышен. `--throttle` и `--cpu` эмулируют медленную сеть и слабое устройство на Android.

### Как мониторить производительность WebView в продакшене?

Подключите `webview-lens/rum` на странице и `webview-lens/rum/server` на сервере: Web Vitals,
кастомные тайминги и JS-ошибки с разбивкой на `android-webview` / `ios-wkwebview` / `browser`,
перцентили p50/p75/p95 и экспорт в Prometheus. См. [docs/ru/rum.md](rum.md).

### Работает ли с Capacitor, Cordova, Ionic, React Native и Flutter?

Да: все они рендерят в Android WebView и iOS WKWebView. В отладочной сборке должна быть разрешена
отладка WebView: Android включает её для debuggable-сборок, у Capacitor есть
`webContentsDebuggingEnabled`, у React Native WebView — `webviewDebuggingEnabled`, у `webview_flutter`
— `AndroidWebViewController.enableDebugging(true)` и `WebKitWebViewController.setInspectable(true)`.

### Работает ли с SSR и SSG (Next.js, Nuxt, SvelteKit, Angular)?

Да: с dev-серверами, production-сборками и статикой; `--forwarded` заставляет SSR-сервер собирать
абсолютные URL для стенда. См. [docs/ru/ssr.md](ssr.md).

## Альтернативы

| Задача                                           | `chrome://inspect` | Safari Web Inspector | `ios_webkit_debug_proxy` | Eruda / vConsole    | HTTP-прокси (Charles, Proxyman) | `webview-lens` |
| ------------------------------------------------ | ------------------ | -------------------- | ------------------------ | ------------------- | ------------------------------- | -------------- |
| Android WebView                                  | ✓                  | —                    | —                        | ✓ (скрипт в сборке) | только сеть                     | ✓              |
| iOS WKWebView                                    | —                  | ✓                    | ✓                        | ✓ (скрипт в сборке) | только сеть                     | ✓              |
| Отладка iOS на Windows                           | —                  | —                    | ✓ (без своего UI)        | ✓                   | только сеть                     | ✓              |
| Полные Chrome DevTools на постоянном адресе      | —                  | —                    | —                        | —                   | —                               | ✓              |
| Локальный dev-сервер под HTTPS-доменом стенда    | —                  | —                    | —                        | —                   | ✓ (Map Remote)                  | ✓ (с HMR)      |
| Логи WebView в терминале                         | —                  | —                    | —                        | —                   | —                               | ✓              |
| Лабораторные Web Vitals на телефоне + бюджеты CI | вручную            | вручную              | —                        | —                   | —                               | ✓              |
| Продакшен-RUM + Prometheus                       | —                  | —                    | —                        | —                   | —                               | ✓              |

`webview-lens` работает на тех же протоколах: `adb` и DevTools-сокет WebView на Android,
`ios_webkit_debug_proxy` на iOS.

## Документация

- Быстрый старт (установка, переменные окружения, Android и iOS по шагам): [docs/ru/getting-started.md](getting-started.md) ([EN](../getting-started.md))
- Рецепты (клавиатура, safe areas, авторизация WebView, JS-bridge, загрузка файлов, управление webview-lens из кода): [docs/ru/recipes.md](recipes.md) ([EN](../recipes.md))
- Как это работает: [docs/ru/how-it-works.md](how-it-works.md) ([EN](../how-it-works.md))
- Архитектура кода и правила: [ARCHITECTURE.md](../../ARCHITECTURE.md) · участие в разработке: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Настройка iOS WKWebView (macOS и Windows): [docs/ru/ios.md](ios.md) ([EN](../ios.md))
- SSR и SSG (Next.js, Nuxt, SvelteKit, Angular): [docs/ru/ssr.md](ssr.md) ([EN](../ssr.md))
- Продакшен-RUM и Prometheus: [docs/ru/rum.md](rum.md) ([EN](../rum.md))
- Соответствие стандартам ISO / RFC: [docs/ru/standards.md](standards.md) ([EN](../standards.md))
- История релизов: [CHANGELOG.md](../../CHANGELOG.md)

## Ограничения

- В тестовых сборках должна быть включена отладка WebView (`WebView.setWebContentsDebuggingEnabled(true)` на Android; `webView.isInspectable = true` на iOS 16.4+) и отключён SSL Pinning для iOS MITM-подмены.
- iOS `WKWebView`: в WebKit нет событий layout-shift, поэтому `CLS` — `n/a`. `LCP` и Event Timing (для `INP`) есть только в свежих iOS: LCP измерен на iOS 26.6, на старых версиях — `n/a`. `--throttle`, `--cpu` и `JS Heap` работают только на Android (CDP).
- Лабораторный INP учитывает только нажатия, сделанные во время `--interact`.
- Продакшен-метрики собираются через RUM; лабораторные цифры с dev-сервера завышены.

## Лицензия

Copyright © 2026 [damilurg](https://github.com/damilurg) (`rootdamilurg@gmail.com`). Распространяется под лицензией [MIT](../../LICENSE).
