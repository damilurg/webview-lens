# Настройка iOS WKWebView (macOS и Windows)

`webview-lens` поддерживает инспекцию, локальную подмену кода и замеры для iOS `WKWebView` с **macOS** и **Windows** без runtime-зависимостей.

## 1. Предварительные требования

| Требование                                         | macOS                                                    | Windows                                                                            |
| -------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **USB-транспорт (`usbmuxd`)**                      | Встроен в macOS (`/var/run/usbmuxd`)                     | Установить **Apple Devices** или **iTunes** из Microsoft Store (`127.0.0.1:27015`) |
| **WebInspector-прокси (`ios_webkit_debug_proxy`)** | `brew install ios-webkit-debug-proxy`                    | `scoop install ios-webkit-debug-proxy` (или распаковать в `~/Downloads`)           |
| **Флаг в тестовой сборке**                         | `webView.isInspectable = true` (iOS 16.4+)               | `webView.isInspectable = true` (iOS 16.4+)                                         |
| **Настройка на iPhone**                            | _Настройки → Safari → Дополнительно → Веб-инспектор_ ВКЛ | _Настройки → Safari → Дополнительно → Веб-инспектор_ ВКЛ                           |

Проверить готовность:

```bash
npx webview-lens doctor --platform ios
```

## 2. Инспекция в Chrome DevTools и live-логи (macOS и Windows)

```bash
npx webview-lens devtools --platform ios --logs
```

- Автоматически запускает `ios_webkit_debug_proxy`, если он установлен, но ещё не запущен.
- Открывает Chrome DevTools на `http://localhost:3300` через встроенный **WIP ↔ CDP мост**.
- С флагом `--logs` выводит `console.*` и ошибки сетевых запросов прямо в терминал.

## 3. Локальный dev-сервер внутри тестовой сборки iOS (`webview-lens dev`)

Поскольку в WebKit Inspector Protocol нет аналога CDP `Fetch.fulfillRequest`, `webview-lens` использует **selective HTTPS MITM-прокси**: он расшифровывает и перенаправляет на `localhost` **только** домен `--remote` (HTTP + нативный WebSocket HMR), а весь остальной трафик пропускает без вмешательства через raw TCP `CONNECT`.

### Одноразовая установка Root CA на тестовый iPhone

```bash
npx webview-lens cert
```

1. Наведите камеру iPhone на QR-код в терминале (или откройте `http://<ваш-lan-ip>:8888/` в Safari).
2. Нажмите **Download iOS Profile (.mobileconfig)** и разрешите загрузку.
3. Откройте **Настройки → Основные → VPN и управление устройством** и установите профиль _webview-lens Local CA_.
4. Откройте **Настройки → Основные → Об этом устройстве → Доверие сертификатам** и включите полное доверие для _webview-lens Local CA_.
5. Убедитесь, что в тестовой/debug iOS-сборке **отключён SSL Pinning**.

### Запуск локальной подмены

```bash
npx webview-lens dev http://localhost:5173 --platform ios --remote https://stand.example.com --cmd "npm run dev" --logs
```

На iPhone откройте **Настройки → Wi-Fi → (i) → Настройка прокси → Вручную** и укажите IP и порт из вывода терминала (по умолчанию `8888`). Откройте WebView-экран в приложении — страница и HMR начнут загружаться с вашего локального dev-сервера.
