# Contributing

## Setup

```bash
nvm use            # Node.js 26 (.nvmrc); 22.18+ works for development
npm ci
npm run verify     # format, types, README ↔ examples sync, tests
npm run bench      # hot-path benchmarks with budgets
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) first: the rules there (pure core, factories with handles,
dependencies as parameters, early return, zero runtime dependencies) are checked in review and partly
by tests.

Node code and browser code are type-checked separately (see "Module map" in ARCHITECTURE.md): tests
of `src/rum/index.ts` and `src/viewport` go in `test/web/`, everything else in `test/`.

## Branches and releases

- Work on a branch from **`dev`**, open a pull request into `dev`. `main` only receives reviewed
  merges from `dev`.
- Every pull request: `npm run verify` green, tests for the change, a line in `CHANGELOG.md` under
  `[Unreleased]`, docs updated in English and Russian (`docs/` and `docs/ru/`).
- Code shown in the docs lives in `examples/` and is copied into Markdown by `npm run examples:sync`
  (CI fails when they drift).
- A release: bump `version` in `package.json`, move `[Unreleased]` to the new version in the
  changelog, merge into `main`, push the tag `vX.Y.Z`. CI publishes to npm (with provenance) and
  GitHub Packages and creates the GitHub Release.

## Device changes

Protocol and device behaviour is verified on real phones before release. Capture what the device sends
(`--log-file run.jsonl`), turn it into a test, then fix. Say in the pull request which device and OS
version you checked.

## Debugging webview-lens itself

```bash
npx webview-lens devtools --verbose              # every adb call, forward, socket, proxy decision
npx webview-lens dev … --log-file run.jsonl      # the same as JSON Lines, attach it to an issue
```
