// Assembles the documentation site from the repository's own Markdown (README, docs/, CHANGELOG),
// so the site and the GitHub/npm READMEs never drift. Output: site/content (git-ignored).
//
// - Each page gets SEO front matter (title, description).
// - Links between documented files become site routes; links to anything else (examples/, LICENSE,
//   source files) become GitHub URLs.
// - The README's centered badge header is replaced by the VitePress home hero.

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
}

export const PAGES: readonly Page[] = [
    {
        source: 'README.md',
        route: '/',
        title: 'Debug Android WebView & iOS WKWebView in Chrome DevTools',
        description:
            'Chrome DevTools for Android WebView and iOS WKWebView on macOS, Windows and Linux: fixed DevTools URL, localhost dev server inside the app, WebView logs, Web Vitals with CI budgets, RUM and Prometheus.',
        home: 'en',
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
        source: 'docs/ru/README.md',
        route: '/ru/',
        title: 'Отладка Android WebView и iOS WKWebView в Chrome DevTools',
        description:
            'Chrome DevTools для Android WebView и iOS WKWebView на macOS, Windows и Linux: постоянный адрес DevTools, локальный dev-сервер внутри приложения, логи WebView, Web Vitals с бюджетами CI, RUM и Prometheus.',
        home: 'ru',
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

const HERO = {
    en: {
        text: 'Debug WebViews in Chrome DevTools',
        tagline:
            'Chrome DevTools, your localhost dev server, live logs and Web Vitals for the web page inside Android WebView and iOS WKWebView — from macOS, Windows or Linux.',
        start: 'Get started',
        startLink: '/#quick-start',
        features: [
            [
                'Fixed DevTools URL',
                'Full Chrome DevTools at http://localhost:3300 that survives app restarts: a chrome://inspect alternative, iOS included.',
            ],
            [
                'iOS on Windows',
                'Debug iOS WKWebView and Safari on Windows and macOS through a WebKit Inspector → Chrome DevTools bridge.',
            ],
            [
                'Localhost inside the app',
                'Your dev server behind the stand’s real HTTPS origin with HMR: no cleartext, no app changes.',
            ],
            [
                'Logs in the terminal',
                'console.log, uncaught exceptions and failed requests from the WebView with --logs.',
            ],
            [
                'Web Vitals on a real phone',
                'LCP, FCP, CLS, INP, TTFB with throttling, Markdown reports and CI budgets.',
            ],
            [
                'RUM + Prometheus',
                'Zero-dependency, SSR-safe client and Fetch API handlers with p50/p75/p95 /metrics.',
            ],
        ],
    },
    ru: {
        text: 'Отладка WebView в Chrome DevTools',
        tagline:
            'Chrome DevTools, локальный dev-сервер, живые логи и Web Vitals для веб-страницы внутри Android WebView и iOS WKWebView — с macOS, Windows или Linux.',
        start: 'Начать',
        startLink: '/ru/#быстрыи-старт',
        features: [
            [
                'Постоянный адрес DevTools',
                'Полные Chrome DevTools на http://localhost:3300, которые переживают перезапуск приложения: замена chrome://inspect, в том числе для iOS.',
            ],
            [
                'iOS на Windows',
                'Отладка iOS WKWebView и Safari на Windows и macOS через мост WebKit Inspector → Chrome DevTools.',
            ],
            [
                'Localhost внутри приложения',
                'Ваш dev-сервер под настоящим HTTPS-доменом стенда с HMR: без cleartext и без правок приложения.',
            ],
            [
                'Логи в терминале',
                'console.log, необработанные исключения и упавшие запросы из WebView с флагом --logs.',
            ],
            [
                'Web Vitals на телефоне',
                'LCP, FCP, CLS, INP, TTFB с троттлингом, отчётами в Markdown и бюджетами для CI.',
            ],
            [
                'RUM + Prometheus',
                'Клиент без зависимостей, безопасный для SSR, и обработчики Fetch API с /metrics p50/p75/p95.',
            ],
        ],
    },
} as const;

// First page wins for a source file (CHANGELOG.md links go to the English /changelog).
const routeBySource = new Map<string, string>();

for (const page of PAGES) {
    if (!routeBySource.has(page.source)) routeBySource.set(page.source, page.route);
}

const yamlString = (value: string): string => JSON.stringify(value);

const frontMatter = (page: Page): string => {
    const lines = [
        `title: ${yamlString(page.title)}`,
        `description: ${yamlString(page.description)}`,
    ];

    if (page.home) {
        const hero = HERO[page.home];

        lines.push(
            'layout: home',
            'hero:',
            '  name: webview-lens',
            `  text: ${yamlString(hero.text)}`,
            `  tagline: ${yamlString(hero.tagline)}`,
            '  actions:',
            '    - theme: brand',
            `      text: ${yamlString(hero.start)}`,
            `      link: ${yamlString(hero.startLink)}`,
            '    - theme: alt',
            '      text: GitHub',
            '      link: https://github.com/damilurg/webview-lens',
            '    - theme: alt',
            '      text: npm',
            '      link: https://www.npmjs.com/package/webview-lens',
            'features:',
            ...hero.features.flatMap(([title, details]) => [
                `  - title: ${yamlString(title)}`,
                `    details: ${yamlString(details)}`,
            ]),
        );
    }

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
    const body = page.home
        ? markdown.replace(/^<div align="center">[\s\S]*?<\/div>\s*/, '')
        : markdown;
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
