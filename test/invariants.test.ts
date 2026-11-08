import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

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

describe('Repository architectural invariants', () => {
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

    it('keeps src/rum/ and src/shared/ Edge/Browser safe (no node:* imports)', () => {
        const violations: string[] = [];

        for (const sub of ['src/rum', 'src/shared']) {
            for (const file of listTsFiles(path.join(ROOT, sub))) {
                const content = fs.readFileSync(file, 'utf8');

                if (/from\s+['"]node:/.test(content)) {
                    violations.push(path.relative(ROOT, file));
                }
            }
        }

        assert.deepEqual(violations, []);
    });
});
