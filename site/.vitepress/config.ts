import fs from 'node:fs';

import { defineConfig, type HeadConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

import { PAGES } from '../build-content.ts';

const SITE = 'https://damilurg.github.io/webview-lens';
const REPO = 'https://github.com/damilurg/webview-lens';
const NPM = 'https://www.npmjs.com/package/webview-lens';
const OG_IMAGE = `${SITE}/og-image.png`;
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
    description: string;
};

const verificationMeta: HeadConfig[] = [
    ['google-site-verification', process.env.GOOGLE_SITE_VERIFICATION],
    ['yandex-verification', process.env.YANDEX_VERIFICATION],
    ['msvalidate.01', process.env.BING_SITE_VERIFICATION],
].flatMap(([name, content]): HeadConfig[] =>
    name && content ? [['meta', { name, content }]] : [],
);

/** Site routes without the base, e.g. '', 'ios', 'ru/', 'ru/ios'. */
const ROUTES = new Set(PAGES.map((page) => page.route.slice(1)));

/** EN ↔ RU counterpart of a route, when the other language has that page. */
const counterpart = (route: string): { en: string; ru: string } | undefined => {
    const en = route.startsWith('ru/') ? route.slice(3) : route;
    const ru = `ru/${en}`;

    return ROUTES.has(en) && ROUTES.has(ru) ? { en, ru } : undefined;
};

/** schema.org description of the package, for search engines and AI assistants. */
const softwareJsonLd = (description: string, lang: string) =>
    JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'webview-lens',
        description,
        inLanguage: lang,
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory:
            'Debugging and performance tools for Android WebView and iOS WKWebView',
        operatingSystem: 'macOS, Windows, Linux',
        softwareVersion: pkg.version,
        url: `${SITE}/`,
        downloadUrl: NPM,
        installUrl: NPM,
        codeRepository: REPO,
        license: 'https://opensource.org/licenses/MIT',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        author: { '@type': 'Person', name: 'damilurg', url: 'https://github.com/damilurg' },
        image: OG_IMAGE,
        keywords:
            'Android WebView debugging, WKWebView debugging, Chrome DevTools, chrome://inspect alternative, iOS debugging on Windows, localhost in WebView, Web Vitals, RUM, Prometheus',
    });

/** Plain text of a Markdown fragment: links to their text, code and emphasis markers dropped. */
const plainText = (markdown: string): string =>
    markdown
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

/**
 * schema.org FAQPage for a "problems and fixes" page: each H2 is a question, the paragraph under it
 * the answer. Search engines and AI assistants read this to answer the question directly.
 */
const faqJsonLd = (source: string, lang: string) => {
    const markdown = fs.readFileSync(new URL(`../../${source}`, import.meta.url), 'utf8');
    const sections = markdown.split(/^## /m).slice(1);

    return JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        inLanguage: lang,
        mainEntity: sections.map((section) => {
            const [question = '', ...rest] = section.split('\n');
            // Prose only: tables and code blocks do not read as an answer.
            const answer = rest
                .join('\n')
                .split(/\n\s*\n/)
                .filter((block) => block.trim() && !/^\s*(\||```)/.test(block))
                .join(' ');

            return {
                '@type': 'Question',
                name: plainText(question),
                acceptedAnswer: { '@type': 'Answer', text: plainText(answer) },
            };
        }),
    });
};

const FAQ_SOURCES: Readonly<Record<string, { source: string; lang: string }>> = {
    troubleshooting: { source: 'docs/troubleshooting.md', lang: 'en' },
    'ru/troubleshooting': { source: 'docs/ru/troubleshooting.md', lang: 'ru' },
};

// Generated page file (relative to srcDir) → the repository file it was built from.
const sourceByFile = new Map(
    PAGES.map((page) => [
        page.route.endsWith('/') ? `${page.route.slice(1)}index.md` : `${page.route.slice(1)}.md`,
        page.source,
    ]),
);
// VitePress serializes this function into the client bundle, so it must not close over
// module variables: the mapping is embedded in its body.
const editLink = (text: string) => ({
    pattern: new Function(
        'payload',
        `return ${JSON.stringify(`${REPO}/edit/main/`)} + (${JSON.stringify(
            Object.fromEntries(sourceByFile),
        )}[payload.filePath] || 'README.md');`,
    ) as (payload: { filePath: string }) => string,
    text,
});

const enSidebar = [
    {
        text: 'Guide',
        items: [
            { text: 'Introduction', link: '/' },
            { text: 'Getting started', link: '/getting-started' },
            { text: 'WebView problems and fixes', link: '/troubleshooting' },
            { text: 'Recipes', link: '/recipes' },
            { text: 'iOS on macOS and Windows', link: '/ios' },
            { text: 'SSR and SSG', link: '/ssr' },
            { text: 'RUM and Prometheus', link: '/rum' },
        ],
    },
    {
        text: 'Reference',
        items: [
            { text: 'Overview', link: '/overview' },
            { text: 'Alternatives', link: '/alternatives' },
            { text: 'How it works', link: '/how-it-works' },
            { text: 'How it was verified', link: '/verification' },
            { text: 'Architecture', link: '/architecture' },
            { text: 'Standards', link: '/standards' },
            { text: 'Changelog', link: '/changelog' },
        ],
    },
];

const ruSidebar = [
    {
        text: 'Руководство',
        items: [
            { text: 'Введение', link: '/ru/' },
            { text: 'Быстрый старт', link: '/ru/getting-started' },
            { text: 'Проблемы WebView и решения', link: '/ru/troubleshooting' },
            { text: 'Рецепты', link: '/ru/recipes' },
            { text: 'iOS на macOS и Windows', link: '/ru/ios' },
            { text: 'SSR и SSG', link: '/ru/ssr' },
            { text: 'RUM и Prometheus', link: '/ru/rum' },
        ],
    },
    {
        text: 'Справка',
        items: [
            { text: 'Обзор', link: '/ru/overview' },
            { text: 'Альтернативы', link: '/ru/alternatives' },
            { text: 'Как это работает', link: '/ru/how-it-works' },
            { text: 'Как проверено', link: '/ru/verification' },
            { text: 'Архитектура', link: '/ru/architecture' },
            { text: 'Стандарты', link: '/ru/standards' },
            { text: 'Changelog', link: '/ru/changelog' },
        ],
    },
];

const socialLinks = [
    { icon: 'github', link: REPO },
    { icon: 'npm', link: NPM },
] as const;

export default withMermaid(
    defineConfig({
        srcDir: 'content',
        base: '/webview-lens/',
        cleanUrls: true,
        // Dates come from the git history of each page's source file (see build-content.ts).
        lastUpdated: true,
        title: 'webview-lens',
        titleTemplate: ':title · webview-lens',
        description:
            'Debug Android WebView and iOS WKWebView in Chrome DevTools on macOS, Windows and Linux.',
        sitemap: { hostname: `${SITE}/` },
        // Mermaid pulls CommonJS modules (fastdom): pre-bundle it so `vitepress dev` loads it as ESM.
        vite: { optimizeDeps: { include: ['mermaid'] } },
        head: [
            ['meta', { name: 'theme-color', content: '#ffffff' }],
            // Search console ownership: set GOOGLE_SITE_VERIFICATION / YANDEX_VERIFICATION (repository
            // variables, passed by the Pages workflow) to the codes the consoles give you.
            ...verificationMeta,
            ['meta', { property: 'og:type', content: 'website' }],
            ['meta', { property: 'og:site_name', content: 'webview-lens' }],
            ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
            ['meta', { property: 'og:image', content: OG_IMAGE }],
            ['meta', { property: 'og:image:width', content: '1200' }],
            ['meta', { property: 'og:image:height', content: '630' }],
            [
                'meta',
                {
                    property: 'og:image:alt',
                    content:
                        'webview-lens: debug the web page inside your mobile app, npx webview-lens devtools',
                },
            ],
            ['meta', { name: 'twitter:image', content: OG_IMAGE }],
            [
                'meta',
                {
                    name: 'keywords',
                    content:
                        'android webview debugging, wkwebview debugging, chrome devtools webview, chrome://inspect alternative, debug ios webview on windows, localhost in webview, webview console logs, web vitals webview, capacitor, react native webview, rum, prometheus',
                },
            ],
        ],
        // Per-page canonical URL, Open Graph and Twitter tags from each page's title/description.
        transformHead: ({ pageData, title, description }) => {
            const route = pageData.relativePath
                .replace(/(^|\/)index\.md$/, '$1')
                .replace(/\.md$/, '');
            const url = `${SITE}/${route}`;
            const tags: HeadConfig[] = [
                ['link', { rel: 'canonical', href: url }],
                ['meta', { property: 'og:url', content: url }],
                ['meta', { property: 'og:title', content: title }],
                ['meta', { property: 'og:description', content: description }],
                ['meta', { name: 'twitter:title', content: title }],
                ['meta', { name: 'twitter:description', content: description }],
                [
                    'meta',
                    { property: 'og:locale', content: route.startsWith('ru/') ? 'ru_RU' : 'en_US' },
                ],
            ];
            const pair = counterpart(route);

            // hreflang: tells search engines the EN and RU pages are translations of each other.
            if (pair) {
                tags.push(
                    ['link', { rel: 'alternate', hreflang: 'en', href: `${SITE}/${pair.en}` }],
                    ['link', { rel: 'alternate', hreflang: 'ru', href: `${SITE}/${pair.ru}` }],
                    [
                        'link',
                        { rel: 'alternate', hreflang: 'x-default', href: `${SITE}/${pair.en}` },
                    ],
                );
            }
            const faq = FAQ_SOURCES[route];

            if (faq) {
                tags.push([
                    'script',
                    { type: 'application/ld+json' },
                    faqJsonLd(faq.source, faq.lang),
                ]);
            }
            if (route === '' || route === 'ru/') {
                tags.push([
                    'script',
                    { type: 'application/ld+json' },
                    softwareJsonLd(description, route ? 'ru' : 'en'),
                ]);
            }

            return tags;
        },
        locales: {
            root: {
                label: 'English',
                lang: 'en',
                themeConfig: {
                    nav: [
                        { text: 'Getting started', link: '/getting-started' },
                        { text: 'Problems', link: '/troubleshooting' },
                        { text: 'Recipes', link: '/recipes' },
                        { text: 'Changelog', link: '/changelog' },
                    ],
                    sidebar: enSidebar,
                    editLink: editLink('Edit this page on GitHub'),
                },
            },
            ru: {
                label: 'Русский',
                lang: 'ru',
                link: '/ru/',
                title: 'webview-lens',
                description:
                    'Отладка Android WebView и iOS WKWebView в Chrome DevTools на macOS, Windows и Linux.',
                themeConfig: {
                    nav: [
                        { text: 'Быстрый старт', link: '/ru/getting-started' },
                        { text: 'Проблемы', link: '/ru/troubleshooting' },
                        { text: 'Рецепты', link: '/ru/recipes' },
                        { text: 'Changelog', link: '/ru/changelog' },
                    ],
                    sidebar: ruSidebar,
                    editLink: editLink('Редактировать на GitHub'),
                    outline: { label: 'На этой странице' },
                    docFooter: { prev: 'Назад', next: 'Дальше' },
                    darkModeSwitchLabel: 'Тема',
                    sidebarMenuLabel: 'Меню',
                    returnToTopLabel: 'Наверх',
                    langMenuLabel: 'Язык',
                },
            },
        },
        themeConfig: {
            siteTitle: 'webview-lens',
            socialLinks: [...socialLinks],
            search: {
                provider: 'local',
                options: {
                    locales: {
                        ru: {
                            translations: {
                                button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
                                modal: {
                                    noResultsText: 'Ничего не найдено',
                                    resetButtonTitle: 'Сбросить',
                                    footer: {
                                        selectText: 'выбрать',
                                        navigateText: 'перейти',
                                        closeText: 'закрыть',
                                    },
                                },
                            },
                        },
                    },
                },
            },
            footer: {
                message: 'Released under the MIT License.',
                copyright: 'Copyright © 2026 damilurg',
            },
        },
    }),
);
