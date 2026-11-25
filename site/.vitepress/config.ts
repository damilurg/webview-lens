import { defineConfig, type HeadConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

import { PAGES } from '../build-content.ts';

const SITE = 'https://damilurg.github.io/webview-lens';
const REPO = 'https://github.com/damilurg/webview-lens';
const NPM = 'https://www.npmjs.com/package/webview-lens';

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
            { text: 'Overview', link: '/' },
            { text: 'How it works', link: '/how-it-works' },
            { text: 'iOS on macOS & Windows', link: '/ios' },
            { text: 'SSR & SSG', link: '/ssr' },
            { text: 'RUM & Prometheus', link: '/rum' },
        ],
    },
    {
        text: 'Reference',
        items: [
            { text: 'Standards conformance', link: '/standards' },
            { text: 'Changelog', link: '/changelog' },
        ],
    },
];

const ruSidebar = [
    {
        text: 'Руководство',
        items: [
            { text: 'Обзор', link: '/ru/' },
            { text: 'Как это работает', link: '/ru/how-it-works' },
            { text: 'iOS на macOS и Windows', link: '/ru/ios' },
            { text: 'SSR и SSG', link: '/ru/ssr' },
            { text: 'RUM и Prometheus', link: '/ru/rum' },
        ],
    },
    {
        text: 'Справка',
        items: [
            { text: 'Соответствие стандартам', link: '/ru/standards' },
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
        lastUpdated: false,
        title: 'webview-lens',
        titleTemplate: ':title · webview-lens',
        description:
            'Debug Android WebView and iOS WKWebView in Chrome DevTools on macOS, Windows and Linux.',
        sitemap: { hostname: `${SITE}/` },
        head: [
            ['meta', { name: 'theme-color', content: '#6f42c1' }],
            ['meta', { property: 'og:type', content: 'website' }],
            ['meta', { property: 'og:site_name', content: 'webview-lens' }],
            ['meta', { name: 'twitter:card', content: 'summary' }],
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
            ];

            return tags;
        },
        locales: {
            root: {
                label: 'English',
                lang: 'en',
                themeConfig: {
                    nav: [
                        { text: 'Guide', link: '/how-it-works' },
                        { text: 'iOS', link: '/ios' },
                        { text: 'SSR & SSG', link: '/ssr' },
                        { text: 'RUM', link: '/rum' },
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
                        { text: 'Руководство', link: '/ru/how-it-works' },
                        { text: 'iOS', link: '/ru/ios' },
                        { text: 'SSR и SSG', link: '/ru/ssr' },
                        { text: 'RUM', link: '/ru/rum' },
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
