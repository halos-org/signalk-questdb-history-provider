# signalk-questdb-history-provider

A Signal K server plugin that records deltas into QuestDB over ILP and serves them back through the v2 History API and the v1 playback API.

## The specification is the reference

`docs/spec/` describes every surface of the plugin. `docs/spec/README.md` is the index; read it before changing behaviour. The rules that shape this repository:

- Every constant in the specification is fixed: the plugin id, config keys and titles, table names and DDL, ILP line shapes, status and error strings, log lines, timing values. Reproduce them exactly.
- Each spec file has an _Observed defects_ heading. The code reproduces those defects on purpose. Fixing one is a separate change with its own issue, and the spec file changes with it.
- Each spec file ends with test-case tables. Every row has a test under `src/test/`. A behaviour change adds or edits a row first.
- `README.md` and `docs/questdb-tuning.md` are operator documentation. The spec lists where they disagree with the code under _Disagreements with the README_.

## Layout

| Path                           | Surface                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `src/index.ts`                 | Factory (default export) and the plugin object; `createPlugin(app, timing)` for tests |
| `src/plugin-id.ts`             | `PLUGIN_ID`; the CI job reads it from `dist/plugin-id.js`                             |
| `src/lifecycle.ts`             | `PluginRuntime`: start sequence, stop, serialised starts, abort points, repair timer  |
| `src/config/schema.ts`         | `ConfigSchema`, the JSON schema handed to the server                                  |
| `src/config/effective.ts`      | Effective value of every key from the stored object                                   |
| `src/ingestion/path-filter.ts` | Literal and glob path filter (minimatch)                                              |
| `src/ingestion/sampling.ts`    | Per-path rate resolution and the sampling gate                                        |
| `src/ingestion/recorder.ts`    | Delta to samples: identity rows, routing by kind, one-level flattening                |
| `src/ilp/line.ts`              | ILP line encoding and the monotonic nanosecond clock                                  |
| `src/ilp/connection.ts`        | The TCP write connection: batching, buffering, reconnect backoff, health messages     |
| `src/storage/sql-client.ts`    | `GET /exec` transport and the health probe                                            |
| `src/storage/tables.ts`        | DDL, retention TTL, schema repair                                                     |
| `src/storage/validate.ts`      | Identifier and timestamp validators                                                   |
| `src/history/time-range.ts`    | `from`, `to`, `duration` resolution with Temporal                                     |
| `src/history/v2.ts`            | `registerHistoryApiProvider` provider                                                 |
| `src/history/v1.ts`            | `registerHistoryProvider` playback provider                                           |

`DISPLAY_NAME` is a placeholder in two places: `signalk.displayName` in `package.json` and the `DISPLAY_NAME` constant in `src/index.ts`. The README search instruction carries the same value. Change all three together.

## Conventions

- The package is ESM (`"type": "module"`) compiled with `moduleResolution: nodenext`. Every relative import carries the `.js` suffix of the emitted file, `import { x } from "./y.js"`, including in test files and type-only imports.
- Strict TypeScript. No `any`. Values that arrive with an unknown shape (the stored config, deltas from the bus, rows from QuestDB) are typed `unknown` and narrowed where they are read.
- The server loads the package through `require`, so no module may use top-level `await`.
- History types come from `@signalk/server-api` under the `history` namespace: `import type { history } from "@signalk/server-api"`.
- The plugin reaches the server only through the app object. No built module may contain `/signalk/v2` or `_providers/_default`; `src/test/no-self-promotion.test.ts` scans `dist/` for both.

## Build and test

Tests run against the compiled output, so build first:

```
npm run build:all   # tsc, then node --test over dist/test
npm run ci-lint     # eslint, then prettier --check
./run test          # the same as build:all
./run lint          # the same as ci-lint
```

`npm run format` applies prettier and eslint fixes.

Test conventions:

- One file per surface under `src/test/`, plus `helpers.ts` with the fakes: a recording app object, a scripted `/exec` HTTP endpoint, a TCP peer for ILP, and a scripted SQL executor.
- `src/test/ilp.test.ts` runs at the production timing constants with `mock.timers` from `node:test` and real sockets. Advance time with `mock.timers.tick`, then wait for real I/O with `waitFor`. Timers in `helpers.ts` are captured before the mocks are enabled.
- `src/test/lifecycle.test.ts` runs with real timers and short timing through `createPlugin(app, timing)`.
- Two `MaxListenersExceededWarning` lines on stderr during the ILP suite are expected: the spec records the drain-listener leak under backpressure as a defect.
- The packaging suite runs `npm pack --dry-run --offline` with a temporary cache directory, so it works in the registry's sandbox.

## Carried-over files

`src/plugin-id.ts`, `src/test/no-self-promotion.test.ts`, `src/test/readme-config-table.test.ts`, `README.md`, `docs/questdb-tuning.md`, and the scaffolding (`package.json`, `tsconfig.json`, `eslint.config.ts`, `run`, `.github/`, `.bumpversion.cfg`, `VERSION`) predate the rewrite. `readme-config-table.test.ts` imports `ConfigSchema` from `src/config/schema.ts`, so that module path is fixed.
