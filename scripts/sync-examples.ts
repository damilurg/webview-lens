// Keeps README / docs code blocks identical to the runnable demos in examples/.
//
// A block is marked in Markdown as:
//   <!-- example: examples/rum/server.ts -->
//   ```ts
//   …generated…
//   ```
//   <!-- /example -->
// The generated code is the example file without `// #region demo-only … // #endregion` blocks,
// with repo-relative `src/` imports replaced by the published package specifiers.
//
// `node scripts/sync-examples.ts` rewrites the blocks; `--check` fails when one is stale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MARKDOWN_FILES = [
    'README.md',
    'docs/ru/README.md',
    'docs/rum.md',
    'docs/ru/rum.md',
    'docs/recipes.md',
    'docs/ru/recipes.md',
];

const PACKAGE_SPECIFIERS: Readonly<Record<string, string>> = {
    'src/node/index.ts': 'webview-lens',
    'src/rum/index.ts': 'webview-lens/rum',
    'src/rum/server.ts': 'webview-lens/rum/server',
    'src/viewport/index.ts': 'webview-lens/viewport',
};

// Prettier puts a blank line between the HTML comments and the fence: allow it both ways.
const BLOCK = /(<!-- example: (\S+) -->\n\n?```\w*\n)([\s\S]*?)(```\n\n?<!-- \/example -->)/g;
const MARKER = /<!-- example: \S+ -->/g;

/** The example source as readers see it: no demo-only regions, package imports. */
export const renderExample = (source: string, exampleFile: string): string => {
    const withoutDemo = source.replace(
        /^[ \t]*\/\/ #region demo-only\n[\s\S]*?^[ \t]*\/\/ #endregion\n?/gm,
        '',
    );
    const exampleDir = path.dirname(path.resolve(root, exampleFile));
    const withPackageImports = withoutDemo.replace(
        /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
        (match, open: string, specifier: string, close: string) => {
            const target = path.relative(root, path.resolve(exampleDir, specifier));
            const published = PACKAGE_SPECIFIERS[target.split(path.sep).join('/')];

            return published ? `${open}${published}${close}` : match;
        },
    );

    return `${withPackageImports.replace(/\n{3,}/g, '\n\n').trim()}\n`;
};

/** Markdown with every example block regenerated and formatted like `prettier --write`. */
export const syncMarkdown = async (
    markdownFile: string,
): Promise<{ before: string; after: string }> => {
    const file = path.join(root, markdownFile);
    const before = fs.readFileSync(file, 'utf8');
    const markers = before.match(MARKER)?.length ?? 0;
    const blocks = before.match(BLOCK)?.length ?? 0;

    if (markers !== blocks) {
        throw new Error(
            `${markdownFile}: ${markers} example marker(s) but ${blocks} well-formed block(s)`,
        );
    }
    const replaced = before.replace(
        BLOCK,
        (_match, head: string, exampleFile: string, _body, tail: string) => {
            const source = fs.readFileSync(path.join(root, exampleFile), 'utf8');

            return `${head}${renderExample(source, exampleFile)}${tail}`;
        },
    );
    const options = (await prettier.resolveConfig(file)) ?? {};
    const after = await prettier.format(replaced, { ...options, filepath: file });

    return { before, after };
};

const main = async () => {
    const check = process.argv.includes('--check');
    const stale: string[] = [];

    for (const markdownFile of MARKDOWN_FILES) {
        const { before, after } = await syncMarkdown(markdownFile);

        if (before === after) continue;
        stale.push(markdownFile);
        if (!check) fs.writeFileSync(path.join(root, markdownFile), after);
    }

    if (stale.length === 0) {
        console.log('Examples and docs are in sync');

        return;
    }
    if (check) {
        console.error(
            `Out of sync with examples/: ${stale.join(', ')}. Run: npm run examples:sync`,
        );
        process.exitCode = 1;

        return;
    }
    console.log(`Updated: ${stale.join(', ')}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
