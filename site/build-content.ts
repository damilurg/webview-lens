// Assembles the documentation site from the repository's own Markdown (README, docs/, CHANGELOG),
// so the site and the GitHub/npm READMEs never drift. Output: site/content (git-ignored).
//
// - Each page gets SEO front matter (title, description).
// - Links between documented files become site routes; links to anything else (examples/, LICENSE,
//   source files) become GitHub URLs.
// - The README's centered badge header is replaced by the VitePress home hero.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(siteDir, '..');
const out = path.join(siteDir, 'content');
const GITHUB = 'https://github.com/damilurg/webview-lens/blob/main';

interface Page {
    source: string;
    route: string;
    title: string;
    description: string;
    home?: 'en' | 'ru';
    /** H1 for a source without one (README's title lives in its GitHub badge header). */
    heading?: string;
}

export const PAGES: readonly Page[] = [
    {
        source: 'docs/home.md',
        route: '/',
        title: 'Debug Android WebView & iOS WKWebView in Chrome DevTools',
        description:
            'Debug the web page inside a mobile app: Chrome DevTools for Android WebView and iOS WKWebView that survive app restarts, your localhost dev server inside the app, WebView logs, keyboard fixes, Web Vitals and RUM. macOS, Windows, Linux.',
        home: 'en',
    },
    {
        source: 'README.md',
        route: '/overview',
        heading: 'Overview',
        title: 'webview-lens overview: commands, requirements, API',
        description:
            'Everything webview-lens does on one page: commands, requirements, several devices at once, DevTools at a fixed address, lab Web Vitals with CI budgets, RUM and Prometheus, programmatic API.',
    },
    {
        source: 'docs/troubleshooting.md',
        route: '/troubleshooting',
        title: 'WebView problems and fixes: chrome://inspect, iOS on Windows, localhost, keyboard',
        description:
            'Why a WebView does not show up in chrome://inspect, how to debug an iOS WKWebView on Windows, load localhost inside the app, see console.log, fix the keyboard covering inputs, measure Web Vitals in the app.',
    },
    {
        source: 'docs/alternatives.md',
        route: '/alternatives',
        title: 'chrome://inspect, Safari Web Inspector, Eruda alternatives for WebView debugging',
        description:
            'webview-lens compared with chrome://inspect, Safari Web Inspector, ios_webkit_debug_proxy, Eruda / vConsole and HTTP proxies like Charles and Proxyman, and when each is the better choice.',
    },
    {
        source: 'docs/getting-started.md',
        route: '/getting-started',
        title: 'Getting started: Android WebView and iOS WKWebView',
        description:
            'Install webview-lens, make the WebView debuggable, connect an Android phone or an iPhone step by step, environment variables and project config.',
    },
    {
        source: 'docs/recipes.md',
        route: '/recipes',
        title: 'WebView recipes: keyboard, safe areas, auth, JS bridge, file upload',
        description:
            'Fixes for WebView pains in Kotlin, Flutter and Swift: keyboard covering inputs, iOS input zoom, safe areas, native sign-in cookies, one JS bridge API, back button, Android file upload.',
    },
    {
        source: 'ARCHITECTURE.md',
        route: '/architecture',
        title: 'Architecture',
        description:
            'How webview-lens is built: a functional core with an imperative shell, factories with handles, dependencies as parameters, and the patterns and tests behind it.',
    },
    {
        source: 'docs/how-it-works.md',
        route: '/how-it-works',
        title: 'How it works',
        description:
            'Architecture of webview-lens: CDP Fetch override, fixed DevTools link, WebSocket bridge and lab Web Vitals inside a native WebView.',
    },
    {
        source: 'docs/ios.md',
        route: '/ios',
        title: 'Debug iOS WKWebView on macOS and Windows',
        description:
            'Inspect iOS WKWebView and Safari in Chrome DevTools on Windows and macOS with usbmuxd and ios_webkit_debug_proxy, and run a local dev server inside an iOS app.',
    },
    {
        source: 'docs/ssr.md',
        route: '/ssr',
        title: 'SSR & SSG inside a WebView: Next.js, Nuxt, SvelteKit, Angular',
        description:
            'Run server-rendered and statically generated apps inside Android WebView and iOS WKWebView: dev servers, production builds, X-Forwarded headers and RUM wiring per framework.',
    },
    {
        source: 'docs/rum.md',
        route: '/rum',
        title: 'Real User Monitoring for WebView apps',
        description:
            'Collect Core Web Vitals, custom timings and JS errors from WebView users and export p50/p75/p95 to Prometheus with zero-dependency Fetch API handlers.',
    },
    {
        source: 'docs/verification.md',
        route: '/verification',
        title: 'How webview-lens was verified on real phones',
        description:
            'Every claim of webview-lens with how it was checked on an Android phone and an iPhone, what was measured, what was found and fixed, and what is not verified.',
    },
    {
        source: 'docs/standards.md',
        route: '/standards',
        title: 'Standards conformance',
        description:
            'RFC 6455 WebSocket, RFC 5280 X.509, RFC 9110 HTTP and ISO/IEC 18004 QR conformance of webview-lens.',
    },
    {
        source: 'CHANGELOG.md',
        route: '/changelog',
        title: 'Changelog',
        description: 'Release history of webview-lens.',
    },
    {
        source: 'CHANGELOG.md',
        route: '/ru/changelog',
        title: 'Changelog',
        description: 'История релизов webview-lens (на английском).',
    },
    {
        source: 'docs/ru/home.md',
        route: '/ru/',
        title: 'Отладка Android WebView и iOS WKWebView в Chrome DevTools',
        description:
            'Отладка веб-страницы внутри мобильного приложения: Chrome DevTools для Android WebView и iOS WKWebView, которые переживают перезапуск, localhost внутри приложения, логи WebView, клавиатура, Web Vitals и RUM.',
        home: 'ru',
    },
    {
        source: 'docs/ru/README.md',
        route: '/ru/overview',
        heading: 'Обзор',
        title: 'Обзор webview-lens: команды, требования, API',
        description:
            'Всё, что умеет webview-lens, на одной странице: команды, требования, несколько устройств сразу, DevTools на постоянном адресе, Web Vitals с бюджетами CI, RUM и Prometheus, программный API.',
    },
    {
        source: 'docs/ru/troubleshooting.md',
        route: '/ru/troubleshooting',
        title: 'Проблемы WebView и решения: chrome://inspect, iOS на Windows, localhost, клавиатура',
        description:
            'Почему WebView не видно в chrome://inspect, как отлаживать iOS WKWebView на Windows, открыть localhost в приложении, увидеть console.log, исправить клавиатуру поверх поля, замерить Web Vitals.',
    },
    {
        source: 'docs/ru/alternatives.md',
        route: '/ru/alternatives',
        title: 'Альтернативы chrome://inspect, Safari Web Inspector и Eruda для отладки WebView',
        description:
            'Сравнение webview-lens с chrome://inspect, Safari Web Inspector, ios_webkit_debug_proxy, Eruda / vConsole и HTTP-прокси вроде Charles и Proxyman, и когда что выбрать.',
    },
    {
        source: 'docs/ru/getting-started.md',
        route: '/ru/getting-started',
        title: 'Быстрый старт: Android WebView и iOS WKWebView',
        description:
            'Установка webview-lens, отлаживаемый WebView, подключение Android-телефона и iPhone по шагам, переменные окружения и конфиг проекта.',
    },
    {
        source: 'docs/ru/recipes.md',
        route: '/ru/recipes',
        title: 'Рецепты WebView: клавиатура, safe areas, авторизация, JS-bridge, файлы',
        description:
            'Решения проблем WebView на Kotlin, Flutter и Swift: клавиатура закрывает поле, зум iOS при фокусе, safe areas, нативный вход через cookie, единый JS-bridge, кнопка «Назад», загрузка файлов на Android.',
    },
    {
        source: 'docs/ru/verification.md',
        route: '/ru/verification',
        title: 'Как webview-lens проверен на реальных телефонах',
        description:
            'Каждое утверждение webview-lens: как проверено на Android и iPhone, что замерено, что найдено и исправлено, что не проверено.',
    },
    {
        source: 'ARCHITECTURE.md',
        route: '/ru/architecture',
        title: 'Architecture',
        description: 'Архитектура webview-lens (на английском).',
    },
    {
        source: 'docs/ru/how-it-works.md',
        route: '/ru/how-it-works',
        title: 'Как это работает',
        description:
            'Архитектура webview-lens: подмена через CDP Fetch, постоянная ссылка на DevTools, мост WebSocket и лабораторные Web Vitals внутри нативного WebView.',
    },
    {
        source: 'docs/ru/ios.md',
        route: '/ru/ios',
        title: 'Отладка iOS WKWebView на macOS и Windows',
        description:
            'Инспекция iOS WKWebView и Safari в Chrome DevTools на Windows и macOS через usbmuxd и ios_webkit_debug_proxy, локальный dev-сервер внутри iOS-приложения.',
    },
    {
        source: 'docs/ru/ssr.md',
        route: '/ru/ssr',
        title: 'SSR и SSG внутри WebView: Next.js, Nuxt, SvelteKit, Angular',
        description:
            'Серверный рендеринг и статическая генерация внутри Android WebView и iOS WKWebView: dev-серверы, production-сборки, заголовки X-Forwarded и RUM для каждого фреймворка.',
    },
    {
        source: 'docs/ru/rum.md',
        route: '/ru/rum',
        title: 'Мониторинг реальных пользователей (RUM) для WebView',
        description:
            'Сбор Core Web Vitals, кастомных таймингов и JS-ошибок от пользователей WebView и экспорт p50/p75/p95 в Prometheus.',
    },
    {
        source: 'docs/ru/standards.md',
        route: '/ru/standards',
        title: 'Соответствие стандартам',
        description:
            'Соответствие webview-lens стандартам RFC 6455, RFC 5280, RFC 9110 и ISO/IEC 18004.',
    },
];

// First page wins for a source file (CHANGELOG.md links go to the English /changelog).
const routeBySource = new Map<string, string>();

for (const page of PAGES) {
    if (!routeBySource.has(page.source)) routeBySource.set(page.source, page.route);
}

const yamlString = (value: string): string => JSON.stringify(value);

/** Last commit date of a source file (ISO 8601), for "Last updated" and sitemap `lastmod`. */
const lastCommitDate = (source: string): string | undefined => {
    try {
        const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', source], {
            cwd: root,
            encoding: 'utf8',
        }).trim();

        return date || undefined;
    } catch {
        return undefined;
    }
};

const frontMatter = (page: Page): string => {
    const updated = lastCommitDate(page.source);
    const lines = [
        `title: ${yamlString(page.title)}`,
        `description: ${yamlString(page.description)}`,
        // Unquoted, so YAML parses it as a date.
        ...(updated ? [`lastUpdated: ${updated}`] : []),
    ];

    // The landing pages read as plain documentation: no hero, no feature cards, no page footer.
    if (page.home) lines.push('aside: false', 'prev: false', 'next: false', 'editLink: false');

    return `---\n${lines.join('\n')}\n---\n\n`;
};

/** Rewrites a Markdown link target found in `source` to a site route or a GitHub URL. */
export const rewriteLink = (target: string, source: string): string => {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) return target;

    const [file = '', fragment] = target.split('#', 2);
    const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
    const route = routeBySource.get(repoPath);
    const hash = fragment ? `#${fragment}` : '';

    if (route) return `${route}${hash}`;

    return `${GITHUB}/${repoPath}${hash}`;
};

/** Page body: README header removed on home pages, links rewritten. */
export const renderPage = (markdown: string, page: Page): string => {
    // README's centred badge header is for GitHub; the site shows the page title instead.
    const stripped = markdown.replace(/^<div align="center">[\s\S]*?<\/div>\s*/, '');
    const body = page.heading ? `# ${page.heading}\n\n${stripped}` : stripped;
    const linked = body.replace(
        /(\[[^\]]*\]\()([^)\s]+)(\))/g,
        (_match, open: string, target: string, close: string) =>
            `${open}${rewriteLink(target, page.source)}${close}`,
    );

    return `${frontMatter(page)}${linked}`;
};

const routeToFile = (route: string): string =>
    route.endsWith('/') ? `${route}index.md` : `${route}.md`;

const main = () => {
    fs.rmSync(out, { recursive: true, force: true });

    for (const page of PAGES) {
        const markdown = fs.readFileSync(path.join(root, page.source), 'utf8');
        const target = path.join(out, routeToFile(page.route));

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, renderPage(markdown, page));
    }

    // Served as-is from the site root for crawlers and AI assistants.
    fs.mkdirSync(path.join(out, 'public'), { recursive: true });
    fs.copyFileSync(path.join(root, 'llms.txt'), path.join(out, 'public', 'llms.txt'));
    for (const file of fs.readdirSync(path.join(siteDir, 'public'))) {
        fs.copyFileSync(path.join(siteDir, 'public', file), path.join(out, 'public', file));
    }

    console.log(`Site content: ${PAGES.length} pages → ${path.relative(root, out)}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
