# Architecture

How webview-lens is built and the rules new code follows. Short version: **a functional core with an
imperative shell**. Protocols, parsing and formatting are pure functions; side effects live in factory
functions that return a handle; dependencies come in as parameters. No classes, no reactive framework,
no runtime dependencies.

## Module map

```
src/
  cli.ts                 entry: parse argv → CliContext → one command
  cli/                   context.ts (flags + config, validated once), runtime.ts (cleanup, loops),
                         commands/ (dev, devtools, vitals, doctor/cert/init)
  node/                  the Node library (`webview-lens`)
    adb.ts device.ts     Android: adb, socket discovery, port forwards, waiting for a page
    cdp.ts               CDP client + TransportAdapter + page picking
    override.ts          `dev` on Android: CDP Fetch interception; bridge-shim.ts is the page side
    devtools-link.ts     fixed DevTools address (Android); devtools-frontend.ts serves the UI
    vitals-lab.ts        lab Web Vitals; telemetry.ts page logs; logger.ts the library's own log
    drivers/             DeviceDriver strategy: android.ts, ios/ (usbmux, iwdp, webkit-targets,
                         wip-cdp-bridge, devtools-bridge, mitm-proxy, certs), registry.ts
  rum/                   browser RUM client + Fetch API handlers (Edge-safe)
  viewport/              browser keyboard/viewport helpers (Edge-safe)
  shared/                code both sides use (Edge-safe)
```

`src/rum`, `src/viewport` and `src/shared` never import `node:*`: they run in browsers, Edge workers,
Bun and Deno. A test enforces it.

## Rules

1. **Pure where possible.** Parsing (`parseDevices`, `parseListDevicesPlist`), protocol translation
   (`translateCdpToWip`), formatting (`formatConsoleEvent`), validation (`validateProjectConfig`) and
   decisions (`pickPage`, `computeViewport`) take data and return data. They carry most of the logic and
   most of the tests.
2. **Side effects in factories.** `create*`, `start*`, `connect*` and `ensure*` open sockets, servers or
   processes and return a handle (`{ send, on, close, closed }`, `{ url, close }`, a stop function).
   State lives in the closure; nothing is exported mutable. The one module-level state is the logging
   configuration (`configureLogging`), set by the entry point.
3. **Dependencies as parameters.** Anything that touches the outside world can be replaced: `runAdb`,
   `fetchImpl`, `connect`, `listPages`, `win` (viewport), driver `deps`. Tests run without a phone.
4. **Options objects with defaults**, destructured in the signature. Optional fields are spread only
   when set (`...(serial ? { serial } : {})`).
5. **Early return, no `else`** (enforced by a test). Guard clauses first, the main path last.
6. **Errors.** Throw `Error` with a message a person can act on (what failed and what to do). User
   errors reach the CLI as one line, no stack trace. A failure that is expected and harmless goes
   through `bestEffort()` with a comment saying why; anything else surfaces.
7. **Logging.** The page's console belongs to DevTools and `--logs`. What webview-lens itself does goes
   through `createLogger(scope)`: silent by default, `--verbose` / `--log-file` to see it.
8. **Zero runtime dependencies** (enforced by a test). Dev tooling only: TypeScript, Prettier.
9. **Decode, don't cast** (enforced by a test that walks the TypeScript AST of `src`). Data from
   outside (protocol frames, page scripts, JSON files, CLI flags) arrives as `unknown` and goes through
   a decoder (`src/shared/decode.ts`, `src/node/protocol.ts`) that returns the value or `undefined`.
   No `as T` (only `as const`), no `<T>x`, no non-null `!`; indexed reads use bounds-checked helpers
   (`buffer.readUInt8`, `itemAt`). Where Node's types are narrower than the runtime (an upgrade socket
   typed as `Duplex`), narrow with a runtime check such as `instanceof net.Socket`.

## Patterns, and where

| Pattern  | Where                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy | `DeviceDriver` with Android and iOS implementations; `resolveDriver` picks one                                                           |
| Adapter  | `wip-cdp-bridge` (WebKit ↔ CDP), `TransportAdapter` / `createWebKitTargetRouter` (WebKit targets), `toNodeHandler` (Fetch ↔ `node:http`) |
| Observer | `cdp.on` / `once` for protocol events, `watchViewport({ onChange })`                                                                     |
| Facade   | `InspectorSession`: the same `evaluate`, `navigate`, `attachTelemetry` over CDP and WebKit                                               |

Not used on purpose: class hierarchies (factories already give encapsulation, and plain objects test
better) and reactive streams (a handful of event streams do not pay for RxJS or a hand-made Observable).

## Tests

| Kind          | Where                                                   | What it guards                                                                           |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Unit          | `test/*.test.ts`                                        | pure functions and factories with injected doubles                                       |
| BDD scenarios | `test/bdd/`                                             | features end to end with fake devices                                                    |
| Contract      | `test/webkit-targets.test.ts`, `test/hardening.test.ts` | protocol behaviour as **recorded from real devices** (iOS 26 targets, Vite's `vite-hmr`) |
| Conformance   | `test/rfc-conformance.test.ts`                          | RFC 6455, RFC 5280, ISO/IEC 18004 details                                                |
| Invariants    | `test/invariants.test.ts`                               | zero deps, no `else`, Edge-safe browser modules, package metadata                        |
| Benchmarks    | `test/bench/`                                           | hot paths with time budgets (`npm run bench`)                                            |

**A fake must replay what a device does, not what we expect it to do.** Every bug found on real phones
(Vite subprotocols, WebKit target routing, `Page.navigate` missing in WebKit, a 404 DevTools revision,
`ios_webkit_debug_proxy -f`, a hidden WebView picked first) passed tests whose doubles followed our
assumptions. New protocol code starts from a capture on a device (`--log-file` helps) turned into a test.

## Adding things

- **A command:** a module in `src/cli/commands/` taking `CliContext`; register it in `src/cli.ts`, add
  flags to `cli/context.ts` and `cli/help.ts`.
- **A platform:** implement `DeviceDriver` in `src/node/drivers/<platform>/`, add it to
  `createDefaultDrivers`, write its contract tests from device captures.
- **A browser module:** a folder under `src/`, an entry in `package.json` `exports`, the Edge-safe
  invariant extended to it.
