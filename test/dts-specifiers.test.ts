// The published declaration files point at files the package ships (`./x.js`), not at the sources.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { rewriteDtsSpecifiers, toJsSpecifier } from '../scripts/dts-specifiers.ts';

describe('toJsSpecifier', () => {
    it('relative .ts / .mts / .cts become .js / .mjs / .cjs', () => {
        assert.equal(toJsSpecifier('./aggregator.ts'), './aggregator.js');
        assert.equal(toJsSpecifier('../shared/decode.ts'), '../shared/decode.js');
        assert.equal(toJsSpecifier('./a.mts'), './a.mjs');
        assert.equal(toJsSpecifier('./a.cts'), './a.cjs');
    });

    it('packages, node: built-ins, .js and .d.ts are left alone', () => {
        assert.equal(toJsSpecifier('typescript'), undefined);
        assert.equal(toJsSpecifier('node:fs'), undefined);
        assert.equal(toJsSpecifier('./a.js'), undefined);
        assert.equal(toJsSpecifier('./types.d.ts'), undefined);
    });

    it('edge: a package whose name ends in .ts, a bare dot, a file named like an extension', () => {
        assert.equal(toJsSpecifier('lodash.ts'), undefined);
        assert.equal(toJsSpecifier('.ts'), undefined);
        assert.equal(toJsSpecifier('./.ts'), './.js');
        assert.equal(toJsSpecifier('./x.tsx'), undefined);
    });
});

describe('rewriteDtsSpecifiers', () => {
    it('rewrites import, export-from and import() types, and nothing else in the file', () => {
        const before = [
            "import type { A } from './a.ts';",
            "export { b, type B } from '../b.ts';",
            "export * from './c.mts';",
            "export declare const d: import('./d.ts').D;",
            "import fs from 'node:fs';",
            "/** Says './not-a-specifier.ts' in a comment. */",
            'export declare const s = "./string.ts";',
        ].join('\n');

        assert.equal(
            rewriteDtsSpecifiers(before),
            [
                "import type { A } from './a.js';",
                "export { b, type B } from '../b.js';",
                "export * from './c.mjs';",
                "export declare const d: import('./d.js').D;",
                "import fs from 'node:fs';",
                "/** Says './not-a-specifier.ts' in a comment. */",
                'export declare const s = "./string.ts";',
            ].join('\n'),
        );
    });

    it('on what tsc really emits from sources that import ./x.ts (the build case)', () => {
        const emitted = ts.transpileDeclaration(
            [
                "import type { Rating } from './thresholds.ts';",
                "export { rate } from './thresholds.ts';",
                'export const pick = (r: Rating): Rating => r;',
            ].join('\n'),
            {
                fileName: 'index.ts',
                compilerOptions: {
                    allowImportingTsExtensions: true,
                    rewriteRelativeImportExtensions: true,
                },
            },
        ).outputText;

        // TypeScript keeps .ts in declarations even with rewriteRelativeImportExtensions: why the script exists.
        assert.match(emitted, /'\.\/thresholds\.ts'/);

        const rewritten = rewriteDtsSpecifiers(emitted);

        assert.doesNotMatch(rewritten, /\.ts'/);
        assert.match(rewritten, /from '\.\/thresholds\.js'/);
        assert.equal(rewriteDtsSpecifiers(rewritten), rewritten);
    });
});
