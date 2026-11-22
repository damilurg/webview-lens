# webview-lens

**[English](README.md)** | **[Русский](README.ru.md)**

Инспекция, локальная подмена кода и замеры производительности для любого веб-приложения внутри
**Android WebView** и **iOS WKWebView** — с **macOS**, **Windows** и **Linux**, без единой
runtime-зависимости (**0 dependencies**). В комплекте также есть лёгкий Edge-safe **RUM**
(Real User Monitoring) клиент, серверные хендлеры, ограниченный по памяти агрегатор перцентилей
(`p50`/`p75`/`p95`) и экспортёр Prometheus `/metrics`.

Страница внутри нативного WebView отличается от десктопного браузера: там есть нативный JS-bridge,
куки и User-Agent от приложения, тема/локаль и запрет на незашифрованный `http://`. `webview-lens`
позволяет запускать локальный dev-сервер (Vite, Next.js, Webpack, Nuxt, Angular или любой другой)
поверх настоящего HTTPS-домена стенда без правок нативного или веб-кода.

| Компонент                 | Назначение                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webview-lens init`       | Определяет сборщик (`vite`, `next`, `webpack`, `nuxt`, `angular`) и создаёт `webview-lens.config.json`                                                                       |
| `webview-lens dev`        | Подменяет HTTPS-домен стенда вашим локальным dev-сервером (Android: CDP `Fetch`; iOS: selective HTTPS MITM) с HMR и `--logs`                                                 |
| `webview-lens devtools`   | Полноценный Chrome DevTools на **постоянном** `http://localhost:3300` (переживает перезапуски приложения; на iOS работает через WIP ↔ CDP мост на Windows и macOS)           |
| `webview-lens cert`       | Генерирует локальный X.509 v3 Root CA и выводит QR-код в терминал для установки `.mobileconfig` на тестовый iPhone                                                           |
| `webview-lens vitals`     | Лабораторные LCP, FCP, CLS, INP, TTFB, Long Tasks, JS Heap и `performance.mark` на реальном телефоне + `--throttle`, `--cpu` и CI-флаг `--budget`                            |
| `webview-lens doctor`     | Пошаговая диагностика подключения (`adb`, `usbmuxd`, `ios_webkit_debug_proxy`, экран блокировки, доступные WebView)                                                          |
| `webview-lens/rum`        | Браузерный клиент (0 `node:*` импортов): Web Vitals, кастомные тайминги, глобальные ошибки, `detectWebViewEnv`, контекстные теги                                             |
| `webview-lens/rum/server` | Edge-safe Fetch API хендлеры (`Request → Response`), адаптер `toNodeHandler` для Express/NestJS, агрегатор `createRumAggregator` (`p50`/`p75`/`p95`) и Prometheus `/metrics` |

## Требования

- **Node.js 22.4+** для CLI (точки входа `webview-lens/rum` и `webview-lens/rum/server` не требуют Node.js).
- **Android:** включена отладка по USB, в тестовой сборке приложения вызвано `WebView.setWebContentsDebuggingEnabled(true)`, установлен `adb` (ищется автоматически в `ADB`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, Android SDK, `PATH` и `~/Downloads`).
- **iOS (macOS и Windows):** в тестовой сборке выставлено `webView.isInspectable = true` (iOS 16.4+), на iPhone включён _Настройки → Safari → Дополнительно → Веб-инспектор_. Для `devtools`/`vitals`/`--logs` нужен `ios_webkit_debug_proxy` (запускается автоматически) и Apple Devices / iTunes на Windows. Подробнее: [docs/ru/ios.md](docs/ru/ios.md).

## Быстрый старт

```bash
npm i -D webview-lens
npx webview-lens init --remote https://stand.example.com
npx webview-lens doctor
npx webview-lens dev
```

## Локальный dev-сервер внутри нативного приложения

```bash
# Android (автоопределение Vite / Next.js / Webpack / Nuxt / Angular)
npx webview-lens dev http://localhost:5173 --cmd "npm run dev" --logs

# iOS (macOS или Windows — предварительно один раз выполните `npx webview-lens cert`)
npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com --cmd "npm run dev" --logs
```

Основные опции (можно зафиксировать в `webview-lens.config.json` или указать через `--config <file>`):

- `--platform auto|android|ios` — выбор платформы (`auto` сам подхватит подключённый телефон).
- `--preset auto|next|vite|webpack|nuxt|angular|generic` — пресеты HMR WebSocket и фильтрации шума статики.
- `--remote <url>` — origin стенда для подмены (на Android определяется автоматически по открытому WebView; на iOS обязателен).
- `--remote-base /shop` и `--local-base /` — маппинг subpath стенда на корень локального сервера (с перезаписью URL, `Referer` и `Location`).
- `--ws <prefix>` — префиксы WebSocket для моста через CDP на Android (повторяемый флаг).
- `--hmr-port <n>` — мост для отдельного порта HMR (Vite/Webpack) поверх CDP + автоматический `adb reverse`.
- `--quiet <prefix>` — скрытие шумных статических путей из лога; `--bypass <prefix>` — пропуск путей напрямую на стенд.
- `--sse fail|continue` — защита от зависания CDP `Fetch` на бесконечных `text/event-stream` ответах.
- `--logs` — стриминг `console.*`, необработанных исключений (1-based `path:line:col`) и 4xx/5xx / упавших сетевых запросов прямо в терминал.
- `--serial <id>` (или `ANDROID_SERIAL`) — выбор конкретного устройства; `--app <package>` — закрепление за нужным Android-пакетом.
- **Enter** перезагружает страницу на Android. **Ctrl+C** завершает работу и останавливает сервер, запущенный через `--cmd`.

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

```ts
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
    path: () => '/event/:id', // поддерживаются шаблоны :param и [param]
    sampleRate: 0.5,
    context,
});
[onCLS, onINP, onLCP, onFCP, onTTFB].forEach((on) => on(report));

export const reportTiming = createTimingReporter({ endpoint: '/api/timings', context });
captureGlobalErrors(createErrorReporter({ endpoint: '/api/client-log', context }));
```

### Сервер (`webview-lens/rum/server`)

Работает нативно в Fetch API средах (Next.js App Router, Hono, Bun, Deno, Cloudflare Workers) и в Express / NestJS / `node:http` через `toNodeHandler`:

```ts
import {
    createClientLogHandler,
    createMetricsHandler,
    createRumAggregator,
    createTimingsHandler,
    createVitalsHandler,
    toNodeHandler,
} from 'webview-lens/rum/server';

const rum = createRumAggregator({ maxSamplesPerSeries: 1000, maxSeries: 200 });

app.post(
    '/api/vitals',
    toNodeHandler(createVitalsHandler({ onMetric: (m) => rum.recordVital(m) })),
);
app.post(
    '/api/timings',
    toNodeHandler(createTimingsHandler({ onTiming: (t) => rum.recordTiming(t) })),
);
app.post(
    '/api/client-log',
    toNodeHandler(createClientLogHandler({ onLog: (e) => rum.recordError(e) })),
);
app.get('/metrics', toNodeHandler(createMetricsHandler(rum))); // Prometheus 0.0.4
```

## Программный API и бенчмарки

Все модули CLI экспортируются из `webview-lens` (`createAndroidDriver`, `createIosDriver`, `resolveDriver`, `startOverride`, `startIosMitmProxy`, `startDevtoolsLink`, `startIosDevtoolsLink`, `measureVitals`, `parseBudgets`, `checkBudgets`, `renderQrTerminal`, `loadProjectConfig` и др.).

Запуск тестов (unit + BDD + ISO/RFC + инварианты) и микробенчмарков:

```bash
npm run verify
npm run bench
```

## Документация

- Как это работает (архитектура): [docs/ru/how-it-works.md](docs/ru/how-it-works.md) ([EN](docs/how-it-works.md))
- Настройка iOS WKWebView (macOS и Windows): [docs/ru/ios.md](docs/ru/ios.md) ([EN](docs/ios.md))
- Продакшен-RUM и Prometheus: [docs/ru/rum.md](docs/ru/rum.md) ([EN](docs/rum.md))
- Соответствие стандартам ISO / RFC: [docs/ru/standards.md](docs/ru/standards.md) ([EN](docs/standards.md))
- История релизов: [CHANGELOG.md](CHANGELOG.md)

## Ограничения

- В тестовых сборках должна быть включена отладка WebView (`WebView.setWebContentsDebuggingEnabled(true)` на Android; `webView.isInspectable = true` на iOS 16.4+) и отключён SSL Pinning для iOS MITM-подмены.
- iOS `WKWebView` не отдаёт часть Core Web Vitals (`CLS`, `INP` и на старых iOS `LCP` помечаются как `n/a`); `--throttle`, `--cpu` и `JS Heap` работают только на Android (CDP).
- Лабораторный INP учитывает только нажатия, сделанные во время `--interact`.
- Продакшен-метрики собираются через RUM; лабораторные цифры с dev-сервера завышены.

## Лицензия

Copyright © 2026 [damilurg](https://github.com/damilurg) (`rootdamilurg@gmail.com`). Распространяется под лицензией [MIT](LICENSE).
