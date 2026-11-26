# Как проверено

Что утверждает webview-lens, как каждое утверждение проверено на реальных телефонах, что
наблюдали и какой тест не даёт ему сломаться. Тестовые двойники повторяют то, что делали
устройства (записано через `--log-file` или `webview-lens keyboard`), поэтому регрессия падает в CI
без телефона.

## Стенд

| Часть      | Что                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android    | Redmi Note 8 Pro, Android 11, Android System WebView 157, по USB (`adb`)                                                                                |
| iPhone     | iPhone 17 Pro, iOS 26.6.1, по USB (`usbmuxd`, `ios_webkit_debug_proxy`) и Wi-Fi до Mac                                                                  |
| Приложения | Kotlin (Android) и Flutter (`webview_flutter`, Android и iOS): нативный вход, стенд в WebView, JS-мост                                                  |
| Стенд      | HTTPS-origin со своим CA: API входа, cookie сессии, сборщик RUM с Prometheus `/metrics`; статический хост или обратный прокси перед сервером фреймворка |
| Веб        | Vite, Next.js 16 (SSR, SSG, Server Action, статический экспорт), Nuxt 4, SvelteKit 3, Angular 22                                                        |
| Даты       | 2026-11-25 – 2026-11-26                                                                                                                                 |

## Утверждения и доказательства

| Утверждение                                                                 | Как проверено                                                                                                       | Что наблюдали                                                                                                                           | Тест                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `dev` отдаёт origin стенда с локального сервера внутри приложения (Android) | Kotlin-приложение, `dev http://127.0.0.1:5173 --remote https://localhost:8443 --logs`, состояние страницы через CDP | бейдж «local dev server», сессия из нативного входа, мост «Connected to Kotlin (android)»                                               | `test/override.test.ts`, `test/bdd/framework-agnostic.bdd.test.ts`       |
| HMR работает через проброшенный WebSocket                                   | правка при открытом приложении (Android и iOS: Vite, Next.js, Nuxt, SvelteKit, Angular)                             | заголовок сменился без перезагрузки (`navigation` осталось 1)                                                                           | `test/override.test.ts` (подпротокол `vite-hmr`), `test/presets.test.ts` |
| `dev` на iOS через выборочный MITM-прокси                                   | Flutter-приложение на iPhone, Wi-Fi-прокси на порт 8888                                                             | бейдж «local dev server», cookie нативного входа, HMR                                                                                   | `test/ios-mitm.test.ts`, `test/bdd/ios-mitm.bdd.test.ts`                 |
| `--logs` выводит консоль, исключения и упавшие запросы                      | `console.warn`, брошенная ошибка и `fetch('/api/fail')` на странице Android                                         | `[console.warn] smoke warn`, `[exception] Error: smoke boom`, `[network] 500 GET …/api/fail`                                            | `test/telemetry.test.ts`, `test/bdd/live-telemetry.bdd.test.ts`          |
| `dev` переходит на WebView, которую приложение создало заново               | найдено в Kotlin-приложении: после поворота `dev` подменял старую, скрытую WebView                                  | исправлено в коде; приложение затем перестало пересоздавать WebView, поэтому само переключение проверено только тестом                  | `test/device.test.ts`                                                    |
| SSR видит нативный вход; с `--forwarded` сервер знает URL стенда            | dev-серверы и production-сборки Next.js 16, Nuxt 4, SvelteKit 3, Angular 22 на обоих телефонах                      | «Signed in as Demo User (session read on the server)», абсолютный URL `https://<стенд>/`; настройки фреймворков в [SSR](ssr.md)         | `test/ssr.test.ts`                                                       |
| Server Actions, form actions и POST проходят CSRF-проверки под `dev`        | формы отправлены из WebView с `--forwarded` и без                                                                   | проходят; SvelteKit adapter-node и Angular требуют настроек из [SSR](ssr.md) (иначе 403 / 400, воспроизведено)                          | `test/ssr.test.ts`                                                       |
| RUM с production-сборок доходит до сборщика с разбивкой по контейнеру       | стенд как обратный прокси перед каждой production-сборкой (webview-lens в цепочке нет), оба приложения              | в `/metrics` серии по путям с `env="android-webview"` и `env="ios-wkwebview"`: Next.js (SSR и экспорт), Nuxt, SvelteKit, Angular        | `test/rum-aggregator.test.ts`, `test/web/rum-reporters.test.ts`          |
| Лабораторные метрики на телефоне                                            | `vitals /` на странице стенда                                                                                       | Android: LCP 244 мс, FCP 180 мс, CLS 0.000, TTFB 41 мс. iPhone: LCP 251 мс, FCP 165 мс, CLS n/a, TTFB 129 мс                            | `test/vitals-lab.test.ts`, `test/bdd/performance-rum.bdd.test.ts`        |
| CLS на iOS — `n/a`                                                          | `vitals` на iPhone                                                                                                  | в WebKit нет записей layout-shift                                                                                                       | `test/vitals-lab.test.ts`                                                |
| Числа клавиатуры (`webview-lens/viewport`, `webview-lens keyboard`)         | `keyboard --overlay` в обоих приложениях, тапы по полям на телефонах                                                | Android: клавиатура 255 px, перекрывает 0 px. iPhone (Flutter): две фазы, 369 px, затем перекрытие 0. Подробно в [рецептах](recipes.md) | `test/web/viewport.test.ts`, `test/keyboard-probe.test.ts`               |
| Несколько телефонов на одном dev-сервере                                    | Android и iPhone открыты одновременно                                                                               | одна правка перезагрузила оба                                                                                                           | нет (вручную)                                                            |

## Найдено на телефонах и исправлено

Каждый из этих случаев проходил тесты, которые были на тот момент: их двойники повторяли наши
допущения. Теперь тесты повторяют то, что сделало устройство.

| Найдено                                                                                                       | Где              | Исправление и тест                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Пресет `angular` пробрасывал `/ng-cli-ws` (времён webpack); HMR Angular 17+ работает на Vite в корне страницы | Android, Angular | пресет пробрасывает `/`; `test/presets.test.ts`                                           |
| `dev` подменял WebView, которую приложение уже заменило (поворот)                                             | Android, Kotlin  | переходит на видимую (на телефоне повторно не прогонялось); `test/device.test.ts`         |
| `--wl-keyboard-height` был завышен на 17 px, когда WebView стала ниже (появилась нативная строка статуса)     | iPhone, Flutter  | база сбрасывается, когда ни одно поле не в фокусе; `test/web/viewport.test.ts`            |
| «Пружина» iOS (`visualViewport.offsetTop` −3 px) прибавлялась к высоте клавиатуры                             | iPhone           | отрицательные смещения игнорируются; `test/web/viewport.test.ts`                          |
| Закреплённая нижняя панель на клавиатуре прятала поле, которое `keepFocusedInputVisible` считал «видимым»     | iPhone, Flutter  | учитываются `fixed` и `sticky` панели (`unobstructedBottom`); `test/web/viewport.test.ts` |
| `vitals https://…` (URL вместо пути) падал на Android и печатал прочерки на iOS                               | оба              | понятная ошибка; `test/bdd/cli.bdd.test.ts`                                               |
| Пререндеренный HTML без `Cache-Control` оставался в кэше обеих WebView после деплоя                           | оба, Nuxt        | описано с исправлением ([SSR](ssr.md)); это поведение стенда, не библиотеки               |

## Не проверено или известно, что не работает

- **iOS, Flutter, переход фокуса между полями при открытой клавиатуре:** WKWebView прокручивает
  новое поле ниже видимой области и игнорирует прокрутку со страницы. Пробовали на устройстве:
  `scrollIntoView` (плавно и сразу), `scrollBy`, `scrollTop`, повторный фокус. Ничто не сдвинуло
  поле. Первый фокус работает. Нужно исправление на нативной стороне.
- **iOS DevTools UI** после рефакторинга декодеров протокола: покрыт `test/bdd/ios-devtools-bridge.bdd.test.ts`, на iPhone повторно не открывался.
- **Swift-приложения (UIKit/SwiftUI)** и **React Native:** рецепты по документации Apple, тестового приложения нет.
- **Android 15+ edge-to-edge** (`adjustResize` больше не меняет размер): рецепт по документации платформы, на тестовом телефоне Android 11.
