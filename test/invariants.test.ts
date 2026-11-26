import assert from 'node:assert/strict';
import fs from 'node:fs';
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

describe('Repository architectural invariants', () => {
    it('library code has no type assertions: data from outside is decoded, not cast', () => {
        const found = listTsFiles(path.join(ROOT, 'src')).flatMap(findTypeAssertions);

        assert.deepEqual(
            found,
            [],
            `Decode instead of asserting (src/shared/decode.ts, src/node/protocol.ts):\n${found.join('\n')}`,
        );
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

    it('keeps core helpers single-sourced (no duplicate utility definitions across src/)', () => {
        const singleSourceRules: readonly { pattern: RegExp; owner: string }[] = [
            { pattern: /\bconst\s+isRecord\s*=/, owner: 'src/shared/utils.ts' },
            { pattern: /\bconst\s+errorMessage\s*=/, owner: 'src/shared/utils.ts' },
            { pattern: /\bconst\s+sleep\s*=/, owner: 'src/shared/utils.ts' },
            { pattern: /\bconst\s+waitWithTimeout\s*=/, owner: 'src/shared/utils.ts' },
            { pattern: /\bconst\s+isFile\s*=/, owner: 'src/node/fs-utils.ts' },
            { pattern: /\bconst\s+listDirs\s*=/, owner: 'src/node/fs-utils.ts' },
            { pattern: /spawnSync\(\s*['"]taskkill['"]/, owner: 'src/node/fs-utils.ts' },
        ];
        const violations: string[] = [];

        for (const file of listTsFiles(path.join(ROOT, 'src'))) {
            const rel = path.relative(ROOT, file).replace(/\\/g, '/');
            const source = fs.readFileSync(file, 'utf8');

            for (const rule of singleSourceRules) {
                if (rel !== rule.owner && rule.pattern.test(source)) {
                    violations.push(`${rel} duplicates helper owned by ${rule.owner}`);
                }
            }
        }

        assert.deepEqual(violations, []);
    });
});
