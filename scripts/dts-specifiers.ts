// Rewrites relative `.ts` module specifiers in the emitted declaration files to `.js`.
//
// The sources import each other as `./x.ts` (Node runs them directly), and the build turns those into
// `./x.js` in the JavaScript with `rewriteRelativeImportExtensions`. TypeScript keeps the declaration
// files as written, so `dist/**/*.d.ts` said `from './aggregator.ts'` while the package ships
// `aggregator.js` and `aggregator.d.ts`. Runs after `tsc` in `npm run build`.
//
//   node scripts/dts-specifiers.ts [dir]           rewrite (default dir: dist)
//   node scripts/dts-specifiers.ts [dir] --check   fail if any declaration still has one

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

// Source extension → the one the build emits.
const EXTENSIONS: readonly (readonly [string, string])[] = [
    ['.mts', '.mjs'],
    ['.cts', '.cjs'],
    ['.ts', '.js'],
];

/** The `.js` form of a relative `.ts` specifier, or undefined when it is not one. */
export const toJsSpecifier = (specifier: string): string | undefined => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
    if (specifier.endsWith('.d.ts')) return undefined;

    const match = EXTENSIONS.find(([ts]) => specifier.endsWith(ts));

    if (!match) return undefined;

    const [from, to] = match;

    return `${specifier.slice(0, -from.length)}${to}`;
};

/** Module specifier literals of a file: import / export ... from, and `import('...')` types. */
const specifierLiterals = (source: ts.SourceFile): ts.StringLiteral[] => {
    const found: ts.StringLiteral[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            found.push(node.moduleSpecifier);
        }
        if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            found.push(node.argument.literal);
        }
        ts.forEachChild(node, visit);
    };

    visit(source);

    return found;
};

/** The declaration file's text with every relative `.ts` specifier pointing at `.js`. */
export const rewriteDtsSpecifiers = (text: string, fileName = 'file.d.ts'): string => {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const edits = specifierLiterals(source).flatMap((literal) => {
        const replacement = toJsSpecifier(literal.text);

        // getStart() skips leading trivia; +1 / -1 keep the quotes.
        return replacement === undefined
            ? []
            : [{ start: literal.getStart(source) + 1, end: literal.getEnd() - 1, replacement }];
    });

    return edits
        .sort((a, b) => b.start - a.start)
        .reduce(
            (out, { start, end, replacement }) =>
                out.slice(0, start) + replacement + out.slice(end),
            text,
        );
};

const declarationFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) return declarationFiles(full);

        return entry.name.endsWith('.d.ts') ? [full] : [];
    });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const dir = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? 'dist');
    const stale: string[] = [];

    for (const file of declarationFiles(dir)) {
        const text = fs.readFileSync(file, 'utf8');
        const rewritten = rewriteDtsSpecifiers(text, file);

        if (rewritten === text) continue;
        if (check) stale.push(path.relative(dir, file));
        if (!check) fs.writeFileSync(file, rewritten);
    }

    if (stale.length > 0) {
        process.stderr.write(`Declaration files with .ts specifiers:\n${stale.join('\n')}\n`);
        process.exitCode = 1;
    }
}
