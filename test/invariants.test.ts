import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');

const listTsFiles = (dir: string): string[] => {
    const out: string[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            out.push(...listTsFiles(full));
            continue;
        }
        if (entry.name.endsWith('.ts')) out.push(full);
    }

    return out;
};

/** Strips comments and string/template literals so keyword checks only inspect executable code. */
const stripCommentsAndStrings = (source: string): string =>
    source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``');

/** Type assertions in a file: `x as T` (not `as const`), `<T>x` and non-null `x!`. */
const findTypeAssertions = (file: string): string[] => {
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        const isConstAssertion =
            ts.isAsExpression(node) &&
            ts.isTypeReferenceNode(node.type) &&
            node.type.typeName.getText(source) === 'const';

        if (
            (ts.isAsExpression(node) && !isConstAssertion) ||
            ts.isTypeAssertionExpression(node) ||
            ts.isNonNullExpression(node)
        ) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));

            found.push(
                `${path.relative(ROOT, file)}:${line + 1} ${node.getText(source).slice(0, 60)}`,
            );
        }
        ts.forEachChild(node, visit);
    };

    visit(source);

    return found;
};

/** `console.*` calls in executable code (not in strings: page scripts are strings). */
const findConsoleCalls = (file: string): string[] => {
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'console'
        ) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));

            found.push(`${path.relative(ROOT, file)}:${line + 1} ${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
    };

    visit(source);

    return found;
};

/** The only places allowed to print: the CLI's terminal output and RUM's opt-in `debug` in the page. */
/** `await` outside any function (top-level await), as `file:line`. */
const findTopLevelAwait = (file: string): string[] => {
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return;
        if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
            found.push(
                `${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
            );
        }
        ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);

    return found;
};

const CONSOLE_ALLOWED = new Set(['src/cli/output.ts', 'src/rum/index.ts']);

describe('Repository architectural invariants', () => {
    it('only the CLI output module prints; the library logs through createLogger or callbacks', () => {
        const found = listTsFiles(path.join(ROOT, 'src'))
            .filter(
                (file) => !CONSOLE_ALLOWED.has(path.relative(ROOT, file).split(path.sep).join('/')),
            )
            .flatMap(findConsoleCalls);

        assert.deepEqual(
            found,
            [],
            `Use terminal (src/cli/output.ts), a log callback or createLogger:\n${found.join('\n')}`,
        );
    });

    it('JSON is parsed in one place, into unknown (no JSON.parse or response.json() elsewhere)', () => {
        const found = listTsFiles(path.join(ROOT, 'src'))
            .filter(
                (file) =>
                    path.relative(ROOT, file).split(path.sep).join('/') !== 'src/shared/decode.ts',
            )
            .flatMap((file) => {
                const source = ts.createSourceFile(
                    file,
                    fs.readFileSync(file, 'utf8'),
                    ts.ScriptTarget.Latest,
                    true,
                );
                const hits: string[] = [];
                const visit = (node: ts.Node): void => {
                    const isJsonParse =
                        ts.isPropertyAccessExpression(node) &&
                        ts.isIdentifier(node.expression) &&
                        node.expression.text === 'JSON' &&
                        node.name.text === 'parse';
                    const isResponseJson =
                        ts.isCallExpression(node) &&
                        ts.isPropertyAccessExpression(node.expression) &&
                        node.expression.name.text === 'json' &&
                        node.arguments.length === 0;

                    if (isJsonParse || isResponseJson)
                        hits.push(`${path.relative(ROOT, file)}: ${node.getText(source)}`);
                    ts.forEachChild(node, visit);
                };

                visit(source);

                return hits;
            });

        assert.deepEqual(
            found,
            [],
            `Use readJson / parseJson from src/shared/decode.ts:\n${found.join('\n')}`,
        );
    });

    it('options objects are destructured: no `options.field` reads of an *Options parameter', () => {
        const findReads = (file: string): string[] => {
            const source = ts.createSourceFile(
                file,
                fs.readFileSync(file, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );
            const hits: string[] = [];
            const visit = (node: ts.Node): void => {
                if (ts.isFunctionLike(node) && 'body' in node && node.body) {
                    for (const parameter of node.parameters) {
                        const isOptions =
                            ts.isIdentifier(parameter.name) &&
                            parameter.type &&
                            ts.isTypeReferenceNode(parameter.type) &&
                            /Options$/.test(parameter.type.typeName.getText(source));

                        if (!isOptions || !ts.isIdentifier(parameter.name)) continue;

                        const name = parameter.name.text;
                        const scan = (inner: ts.Node): void => {
                            if (
                                ts.isPropertyAccessExpression(inner) &&
                                ts.isIdentifier(inner.expression) &&
                                inner.expression.text === name
                            ) {
                                const { line } = source.getLineAndCharacterOfPosition(
                                    inner.getStart(source),
                                );

                                hits.push(
                                    `${path.relative(ROOT, file)}:${line + 1} ${inner.getText(source)}`,
                                );
                            }
                            ts.forEachChild(inner, scan);
                        };

                        scan(node.body);
                    }
                }
                ts.forEachChild(node, visit);
            };

            visit(source);

            return hits;
        };
        const found = listTsFiles(path.join(ROOT, 'src')).flatMap(findReads);

        assert.deepEqual(
            found,
            [],
            `Destructure the options in the signature (or first line, when passed on):\n${found.join('\n')}`,
        );
    });

    it('the console check finds console calls, and ignores them inside strings', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-console-'));
        const file = path.join(dir, 'probe.ts');

        fs.writeFileSync(file, "const page = 'console.log(1)';\nconsole.error('x');\n");
        assert.deepEqual(
            findConsoleCalls(file).map((hit) => hit.split(' ').pop()),
            ['console.error'],
        );
    });
    it('library code has no type assertions: data from outside is decoded, not cast', () => {
        const found = listTsFiles(path.join(ROOT, 'src')).flatMap(findTypeAssertions);

        assert.deepEqual(
            found,
            [],
            `Decode instead of asserting (src/shared/decode.ts, src/node/protocol.ts):\n${found.join('\n')}`,
        );
    });

    it('no top-level await in the package modules: CommonJS projects can require() them (Node 22.12+)', () => {
        // require(esm) refuses a module graph with top-level await (ERR_REQUIRE_ASYNC_MODULE). The CLI
        // entry is only run, never required.
        const found = listTsFiles(path.join(ROOT, 'src'))
            .filter((file) => path.relative(ROOT, file) !== path.join('src', 'cli.ts'))
            .flatMap(findTopLevelAwait);

        assert.deepEqual(found, []);
    });

    it('the top-level await check finds it at the top level and in for await, not inside functions', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvl-tla-'));
        const file = path.join(dir, 'mod.ts');

        fs.writeFileSync(
            file,
            [
                'await ready;',
                'const f = async () => { await x; };',
                'async function g() { for await (const a of b) {} }',
                'for await (const c of d) {}',
                'class K { static { void 0; } m = async () => await y; }',
                'export const v = await load();',
            ].join('\n'),
        );
        try {
            assert.deepEqual(
                findTopLevelAwait(file).map((hit) => hit.split(':').pop()),
                ['1', '4', '6'],
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('maintains zero runtime dependencies in package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
        };

        assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    });

    it('enforces early-return style: no `else` statements in executable code under src/', () => {
        const violations: string[] = [];

        for (const file of listTsFiles(path.join(ROOT, 'src'))) {
            const stripped = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));

            if (/\belse\b/.test(stripped)) {
                violations.push(path.relative(ROOT, file));
            }
        }

        assert.deepEqual(violations, []);
    });

    it('keeps src/rum/, src/shared/ and src/viewport/ Edge/Browser safe (no node:* imports)', () => {
        const violations: string[] = [];

        for (const sub of ['src/rum', 'src/shared', 'src/viewport']) {
            for (const file of listTsFiles(path.join(ROOT, sub))) {
                const content = fs.readFileSync(file, 'utf8');

                if (/from\s+['"]node:/.test(content)) {
                    violations.push(path.relative(ROOT, file));
                }
            }
        }

        assert.deepEqual(violations, []);
    });

    it('satisfies npm release package.json invariants (engines, files, exports, bin shebang)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
            engines?: { node?: string };
            files?: string[];
            bin?: Record<string, string>;
            exports?: Record<string, { default?: string; types?: string } | string>;
            scripts?: Record<string, string>;
            description?: string;
            keywords?: string[];
        };

        assert.match(pkg.engines?.node ?? '', />=22\.4/);
        assert.ok(pkg.files?.includes('dist'));
        assert.ok(pkg.files?.includes('docs'));
        assert.ok(pkg.files?.includes('README.md'));
        // npm 11 picks the package page README among packed README* files: only the English one ships.
        assert.ok(!pkg.files?.some((file) => /^readme\..+\.md$/i.test(file)));
        assert.ok(pkg.files?.includes('LICENSE'));
        assert.ok(pkg.scripts?.clean);
        assert.ok(pkg.scripts?.prebuild);
        assert.match(pkg.description ?? '', /iOS|WKWebView/i);
        assert.ok(pkg.keywords?.includes('ios'));
        assert.ok(pkg.keywords?.includes('wkwebview'));

        const cliBin = pkg.bin?.['webview-lens'];

        assert.ok(cliBin);
        const cliFile = path.join(ROOT, cliBin);

        if (fs.existsSync(cliFile)) {
            assert.ok(fs.readFileSync(cliFile, 'utf8').startsWith('#!/usr/bin/env node\n'));
        }
    });

    it('keeps helpers single-sourced: no top-level function name is defined in two src files', () => {
        const owners = new Map<string, string[]>();

        for (const file of listTsFiles(path.join(ROOT, 'src'))) {
            const rel = path.relative(ROOT, file).split(path.sep).join('/');
            const source = ts.createSourceFile(
                file,
                fs.readFileSync(file, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );

            for (const statement of source.statements) {
                const names =
                    ts.isFunctionDeclaration(statement) && statement.name
                        ? [statement.name.text]
                        : ts.isVariableStatement(statement)
                          ? statement.declarationList.declarations.flatMap((declaration) =>
                                ts.isIdentifier(declaration.name) &&
                                declaration.initializer &&
                                (ts.isArrowFunction(declaration.initializer) ||
                                    ts.isFunctionExpression(declaration.initializer))
                                    ? [declaration.name.text]
                                    : [],
                            )
                          : [];

                for (const name of names) owners.set(name, [...(owners.get(name) ?? []), rel]);
            }
        }

        const duplicates = [...owners]
            .filter(([, files]) => files.length > 1)
            .map(([name, files]) => `${name}: ${files.join(', ')}`);

        assert.deepEqual(duplicates, []);

        // Killing a process tree on Windows has one owner too.
        const taskkill = listTsFiles(path.join(ROOT, 'src')).filter(
            (file) =>
                !file.endsWith(path.join('node', 'fs-utils.ts')) &&
                /spawnSync\(\s*['"]taskkill['"]/.test(fs.readFileSync(file, 'utf8')),
        );

        assert.deepEqual(taskkill, []);
    });
});
