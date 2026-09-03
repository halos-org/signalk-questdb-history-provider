# Configuration

## Purpose

The plugin exposes one JSON-schema configuration object to the Signal K server. The server renders it as a form in the Admin UI under **Apps & Plugins -> Configuration -> DISPLAY_NAME**, stores the submitted object verbatim, and hands the stored object to the plugin at every start. The object names the QuestDB the plugin connects to, selects which Signal K paths and which vessel contexts get recorded, bounds how often each path is written, and sets how long QuestDB keeps the rows. Because the server stores exactly what was submitted and applies no schema defaults itself, the plugin derives an effective value for every key at start from whatever the stored object holds. A configuration change takes effect when the server restarts the plugin, which it does on every save from the Admin UI.

## Interface constants

### Plugin identity as shown in the Admin UI

| Constant    | Value                                                  |
| ----------- | ------------------------------------------------------ |
| Plugin id   | `signalk-questdb-history-provider`                     |
| Plugin name | DISPLAY_NAME (chosen later; see the packaging surface) |

### Configuration keys

Every key is listed in the schema's `required` array. The `Admin UI title` and `Admin UI description` columns hold the exact `title` and `description` strings the schema carries; a dash means the schema carries none.

| Key                   | JSON type                                                | Default       | Admin UI title                       | Admin UI description                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------- | ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `questdbHost`         | `string`                                                 | `"127.0.0.1"` | `QuestDB host`                       | `Hostname or address of the QuestDB server to connect to.`                                                                                                                                 |
| `questdbIlpPort`      | `number`                                                 | `9009`        | `ILP port (writes)`                  | `QuestDB's line-protocol port. QuestDB's own default is 9009.`                                                                                                                             |
| `questdbHttpPort`     | `number`                                                 | `9000`        | `HTTP port (queries)`                | `QuestDB's HTTP port, used for queries. Its default is 9000.`                                                                                                                              |
| `pathFilter`          | `object` with required `mode` and `paths`                | -             | -                                    | -                                                                                                                                                                                          |
| `pathFilter.mode`     | `anyOf` two `string` constants: `"exclude"`, `"include"` | `"exclude"`   | `Filter mode`                        | -                                                                                                                                                                                          |
| `pathFilter.paths`    | `array` of `string`                                      | `[]`          | `Path patterns (glob supported)`     | `e.g. "notifications.*", "environment.wind.*"`                                                                                                                                             |
| `defaultSamplingRate` | `number`                                                 | `2000`        | `Default sampling rate (ms)`         | `Minimum ms between writes for any path (0 = write every update). 2000ms is a sensible default for Pi-class hardware; lower it per-path via samplingRates when you need finer resolution.` |
| `samplingRates`       | `object`, `patternProperties` `"^.*$"` -> `number`       | `{}`          | `Per-path sampling rates (ms)`       | `Override default rate for specific paths. e.g. { "environment.wind.*": 200, "tanks.*": 10000 }`                                                                                           |
| `recordSelf`          | `boolean`                                                | `true`        | `Record own vessel`                  | -                                                                                                                                                                                          |
| `recordOthers`        | `boolean`                                                | `true`        | `Record other vessels`               | -                                                                                                                                                                                          |
| `retentionDays`       | `number`                                                 | `0`           | `Retention (days, 0 = keep forever)` | -                                                                                                                                                                                          |

Schema property order, top to bottom, is: `questdbHost`, `questdbIlpPort`, `questdbHttpPort`, `pathFilter` (`mode`, then `paths`), `defaultSamplingRate`, `samplingRates`, `recordSelf`, `recordOthers`, `retentionDays`. The Admin UI renders the fields in this order.

The schema as emitted to the server, exactly:

```json
{
  "type": "object",
  "required": [
    "questdbHost",
    "questdbIlpPort",
    "questdbHttpPort",
    "pathFilter",
    "defaultSamplingRate",
    "samplingRates",
    "recordSelf",
    "recordOthers",
    "retentionDays"
  ],
  "properties": {
    "questdbHost": {
      "type": "string",
      "default": "127.0.0.1",
      "title": "QuestDB host",
      "description": "Hostname or address of the QuestDB server to connect to."
    },
    "questdbIlpPort": {
      "type": "number",
      "default": 9009,
      "title": "ILP port (writes)",
      "description": "QuestDB's line-protocol port. QuestDB's own default is 9009."
    },
    "questdbHttpPort": {
      "type": "number",
      "default": 9000,
      "title": "HTTP port (queries)",
      "description": "QuestDB's HTTP port, used for queries. Its default is 9000."
    },
    "pathFilter": {
      "type": "object",
      "required": ["mode", "paths"],
      "properties": {
        "mode": {
          "anyOf": [
            { "type": "string", "const": "exclude" },
            { "type": "string", "const": "include" }
          ],
          "default": "exclude",
          "title": "Filter mode"
        },
        "paths": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "title": "Path patterns (glob supported)",
          "description": "e.g. \"notifications.*\", \"environment.wind.*\""
        }
      }
    },
    "defaultSamplingRate": {
      "type": "number",
      "default": 2000,
      "title": "Default sampling rate (ms)",
      "description": "Minimum ms between writes for any path (0 = write every update). 2000ms is a sensible default for Pi-class hardware; lower it per-path via samplingRates when you need finer resolution."
    },
    "samplingRates": {
      "type": "object",
      "patternProperties": { "^.*$": { "type": "number" } },
      "default": {},
      "title": "Per-path sampling rates (ms)",
      "description": "Override default rate for specific paths. e.g. { \"environment.wind.*\": 200, \"tanks.*\": 10000 }"
    },
    "recordSelf": {
      "type": "boolean",
      "default": true,
      "title": "Record own vessel"
    },
    "recordOthers": {
      "type": "boolean",
      "default": true,
      "title": "Record other vessels"
    },
    "retentionDays": {
      "type": "number",
      "default": 0,
      "title": "Retention (days, 0 = keep forever)"
    }
  }
}
```

### Keys that must not exist

| Key                        | Requirement                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `promoteToDefaultProvider` | Must not be a schema property. The schema offers no option, under any name, that makes the plugin the server's default history provider. |

### Effective value per key

The value the plugin uses for a key during a run, derived from the stored object at start. Missing means the key is absent, `undefined`, or `null`.

| Key                   | Missing                              | Present with any other value                                       |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `questdbHost`         | `"127.0.0.1"`                        | As stored, including the empty string                              |
| `questdbIlpPort`      | `9009`                               | As stored                                                          |
| `questdbHttpPort`     | `9000`                               | As stored                                                          |
| `pathFilter`          | `{ "mode": "exclude", "paths": [] }` | Each field per its own row below                                   |
| `pathFilter.mode`     | `"exclude"`                          | As stored                                                          |
| `pathFilter.paths`    | `[]`                                 | As stored                                                          |
| `defaultSamplingRate` | `2000`                               | As stored, including `0`, negative numbers, `NaN`                  |
| `samplingRates`       | `{}`                                 | As stored                                                          |
| `recordSelf`          | `true`                               | `false` when the stored value is exactly `false`; otherwise `true` |
| `recordOthers`        | `true`                               | `false` when the stored value is exactly `false`; otherwise `true` |
| `retentionDays`       | `0`                                  | As stored, including negative and fractional numbers               |

### Glob metacharacters

A pattern in `pathFilter.paths` or a key in `samplingRates` is a glob when it contains any of these characters: `*` `?` `[` `]` `{` `}` `!` `+` `@` `(` `)` `|`. A pattern with none of them is an exact string.

### Strings that carry configured values

| String                                                      | Where it appears                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `Recording to QuestDB at <questdbHost>:<questdbIlpPort>`    | Plugin status line once recording runs                     |
| `QuestDB not responding at <questdbHost>:<questdbHttpPort>` | Plugin error line when QuestDB's HTTP port stays unhealthy |
| `Could not apply the retention setting: <message>`          | Server error log when the retention statement fails        |
| `ALTER TABLE <table> SET TTL <n> DAYS`                      | SQL sent per owned table when `retentionDays` is 1 or more |
| `ALTER TABLE <table> SET TTL 0h`                            | SQL sent per owned table when `retentionDays` is 0         |

Owned tables, in the order the retention statement is sent: `signalk`, `signalk_str`, `signalk_position`.

### README configuration table

The README section `## Configuration` holds one table with the columns `Setting`, `Default`, `Description`. The table lists exactly the nine rows below, with these labels and these `Default` cells. Each row stands for one schema key, and that key's schema `title` is the Admin UI title listed for the row. The row label is not the schema title; several labels are deliberate shortenings of it.

| README row label       | Schema key            | Admin UI title the row stands for    | Default cell as rendered |
| ---------------------- | --------------------- | ------------------------------------ | ------------------------ |
| `QuestDB host`         | `questdbHost`         | `QuestDB host`                       | `` `127.0.0.1` ``        |
| `HTTP port`            | `questdbHttpPort`     | `HTTP port (queries)`                | `` `9000` ``             |
| `ILP port`             | `questdbIlpPort`      | `ILP port (writes)`                  | `` `9009` ``             |
| `Sampling rate (ms)`   | `defaultSamplingRate` | `Default sampling rate (ms)`         | `` `2000` ``             |
| `Record own vessel`    | `recordSelf`          | `Record own vessel`                  | `` `true` ``             |
| `Record other vessels` | `recordOthers`        | `Record other vessels`               | `` `true` ``             |
| `Retention (days)`     | `retentionDays`       | `Retention (days, 0 = keep forever)` | `` `0` ``                |
| `Path filter mode`     | `pathFilter.mode`     | `Filter mode`                        | `` `exclude` ``          |
| `Path filter paths`    | `pathFilter.paths`    | `Path patterns (glob supported)`     | `_(empty)_`              |

A `Default` cell is the schema default written as `` `value` ``: a string bare, any other value as JSON; an empty array is written `_(empty)_`. Every leaf key of the schema (descending into `pathFilter`) has a row, except `samplingRates`. No row exists for a label outside this list.

`samplingRates` has no table row. The README documents it in a paragraph below the table, under the bold heading **Per-path sampling rates (ms)**, with the example `{ "environment.wind.*": 200 }`.

The README table, verbatim:

```markdown
| Setting              | Default     | Description                                                                                           |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| QuestDB host         | `127.0.0.1` | Host your QuestDB listens on                                                                          |
| HTTP port            | `9000`      | QuestDB's HTTP port, used for queries                                                                 |
| ILP port             | `9009`      | QuestDB's line-protocol port, used for writes                                                         |
| Sampling rate (ms)   | `2000`      | Default min ms between writes per path (0 = every update)                                             |
| Record own vessel    | `true`      | Record self context                                                                                   |
| Record other vessels | `true`      | Record contexts other than self                                                                       |
| Retention (days)     | `0`         | Table TTL; QuestDB expires whole partitions (0 = keep forever)                                        |
| Path filter mode     | `exclude`   | `exclude` matching paths, or `include` only matching paths                                            |
| Path filter paths    | _(empty)_   | Glob patterns, one per line (e.g. `notifications.*`); empty = record everything, which is the default |
```

## Behaviour

### Schema handed to the server

1. The plugin object the server loads carries the schema above as its `schema` property, its id as `signalk-questdb-history-provider`, and its display name as DISPLAY_NAME.
2. The schema is a plain JSON-schema object. It carries no `$schema`, `$id`, `additionalProperties`, `minimum`, `maximum`, `pattern`, `minLength`, or `enum` keyword. The two allowed values of `pathFilter.mode` are expressed as `anyOf` two `const` strings.
3. The ports are `number`, not `integer`. The schema does not restrict them to a range.
4. `samplingRates` is an object whose every property name is allowed (`patternProperties` `"^.*$"`) and whose every value is a `number`. The Admin UI does not render it as individual fields; the operator enters a JSON object.
5. Every schema key has a `default`, except `pathFilter` itself. `pathFilter.mode`, `recordSelf`, `recordOthers`, and `retentionDays` have a `title` and no `description`. `pathFilter` has neither `title` nor `description`.
6. The schema contains no property that promotes the plugin to the server's default history provider. There is no `promoteToDefaultProvider` key and no equivalent under another name. Whether the plugin claims that slot is not decided by configuration; the lifecycle surface requires that it never does.

### What the server stores and delivers

7. The server stores the object the Admin UI submits, without applying schema defaults, and delivers that object unchanged to the plugin at start. A configuration saved before a key existed, or edited by hand in the plugin's configuration file, arrives without that key.
8. Keys in the delivered object that are not in the schema are preserved and ignored.
9. The plugin never rewrites the stored configuration. A later start receives the same stored object again.

### Effective values

10. At every start the plugin derives the effective value of every key from the delivered object per the table `Effective value per key`. The effective values hold for the whole run.
11. A `pathFilter` object that is missing entirely, or present with only one of its two fields, is completed per field: the present field keeps its value and the missing field takes its effective default.
12. A missing key never fails the start and never stops recording. A configuration that is missing every key behaves exactly like the schema defaults.
13. No effective value is validated or coerced. A stored value of the wrong type is used as stored, with these consequences:
    1. `defaultSamplingRate` stored as a numeric string, for example `"2000"`, throttles as that number of milliseconds. Stored as a non-numeric string, for example `"abc"`, or as `NaN`, it admits every update, the same as `0`. Stored as the empty string, it admits every update.
    2. `retentionDays` stored as a numeric string, for example `"7"`, is applied as that number of days (`SET TTL 7 DAYS`). Stored as a non-numeric string, for example `"abc"`, it is applied as `SET TTL 0h`.
    3. `questdbIlpPort` or `questdbHttpPort` stored as a numeric string, for example `"9009"`, connects to that port.
    4. `pathFilter.mode` stored as any string other than `"exclude"` selects include behaviour (rule 21).
    5. `pathFilter.paths` stored as a string is treated as a sequence of one-character patterns. A `*` among them is a one-character glob that matches every path, so exclude mode then records nothing and include mode records everything. Stored as a value that cannot be iterated, for example a number or an object, the start fails with `Startup failed: <message>`.

### QuestDB endpoints

14. The HTTP endpoint is the effective `questdbHost` and `questdbHttpPort`. The plugin uses it for the readiness probe, table creation, schema repair, retention, and every history query.
15. The ILP endpoint is the effective `questdbHost` and `questdbIlpPort`. The plugin uses it for every row written.
16. Both endpoints share the one host value. The configuration offers no separate host for writes and queries.
17. The plugin makes outbound TCP connections to those endpoints only. It opens no listening port and publishes nothing.
18. The plugin status line while recording is `Recording to QuestDB at <questdbHost>:<questdbIlpPort>`. The error line when the HTTP endpoint does not answer within the startup wait is `QuestDB not responding at <questdbHost>:<questdbHttpPort>`. Both show the effective values.

### Path filter

19. The filter applies to every recorded data path. It does not apply to vessel-name identity rows, which are recorded regardless of the filter.
20. When the effective `pathFilter.paths` is empty, every path is recorded, whatever `pathFilter.mode` says.
21. When `pathFilter.paths` is not empty, a path matches the filter when it equals an exact pattern or when any glob pattern matches it. A pattern is a glob when it contains a glob metacharacter (see the constants table); otherwise it is compared as an exact string. Glob patterns follow minimatch semantics.
22. With `pathFilter.mode` equal to `"exclude"`, a matching path is not recorded and a non-matching path is recorded. With any other value of `pathFilter.mode`, a matching path is recorded and a non-matching path is not. Only the exact string `"exclude"` selects exclude behaviour.
23. A delta whose value is an object is filtered on each flattened leaf path (for example `navigation.attitude.roll`), not on the parent path. A pattern that names only the parent path does not match the leaves unless it is a glob that covers them.

### Sampling rates

24. `defaultSamplingRate` is the minimum number of milliseconds between two writes of the same path for the same vessel context. A value of `0` or less disables throttling for paths without an override: every update is written.
25. Throttling is keyed per path and per stored context. A delta for the own vessel uses the context `self`; a delta for any other vessel uses its context string as delivered. Two vessels reporting the same path are throttled independently. The delta's source is not part of the key.
26. `samplingRates` maps a pattern to an interval in milliseconds and overrides `defaultSamplingRate` for the paths it matches. Matching follows the same exact-string and glob rules as the path filter.
27. Override resolution, first match wins: an exact pattern equal to the path wins over any glob; among globs, the first matching entry in the object's key order wins.
28. An override whose value is not a number greater than `0` (that is, `0`, a negative number, or `NaN`) is ignored. A path matched only by such an entry uses `defaultSamplingRate`.
29. An object-valued delta is throttled on each leaf path with that leaf's rate, not on the parent path.
30. Vessel-name identity rows are throttled with the path `name` and the vessel's stored context. A `samplingRates` entry whose pattern matches the string `name` applies to them; otherwise `defaultSamplingRate` applies.

### Recording toggles

31. When the effective `recordSelf` is `false`, no row of any kind is written for the own vessel's context, including its name.
32. When the effective `recordOthers` is `false`, no row of any kind is written for any context other than the own vessel's, including names.
33. Both toggles are effectively `true` unless the stored value is exactly `false` (see the table `Effective value per key`).

### Retention

34. At every start, after the tables exist and the ILP connection is up, the plugin sets the QuestDB TTL on each owned table from `retentionDays`.
35. The value is first floored to an integer, then clamped to a minimum of `0`. `1.9` becomes `1`; `-5` becomes `0`; `0.5` becomes `0`.
36. When the result is `1` or more, the plugin sends `ALTER TABLE <table> SET TTL <n> DAYS` for each owned table. When the result is `0`, or is not a number, it sends `ALTER TABLE <table> SET TTL 0h`, which clears the TTL and keeps rows forever.
37. The statement is sent to the tables in the order `signalk`, `signalk_str`, `signalk_position`.
38. The plugin sends the same retention statement again after it rebuilds a table during schema repair, so a rebuilt table carries the configured TTL.
39. When a retention statement fails, the plugin logs `Could not apply the retention setting: <error message>` through the server's error log and continues the start. Recording is not blocked by a retention failure, and the plugin status line does not report it.

### Admin UI presentation

40. The Admin UI shows the plugin under **Apps & Plugins -> Configuration -> DISPLAY_NAME**. It renders each schema `title` as the field label and each `description` as help text under the field.
41. The Admin UI applies the schema defaults to a form whose stored configuration lacks a key, so the operator sees the default values in the form. Saving the form is what writes those values into the stored configuration.
42. Because schema defaults are applied only by the form, the effective values in rules 10 to 12 are what make a never-saved or hand-edited configuration behave like the defaults the form shows.

## Cross-surface references

- The plugin id `signalk-questdb-history-provider` and the DISPLAY_NAME placeholder are shared with the packaging and lifecycle surfaces.
- The status strings `Recording to QuestDB at <host>:<ilpPort>` and `QuestDB not responding at <host>:<httpPort>` are set by the lifecycle surface and carry the effective host and ports.
- The owned tables `signalk`, `signalk_str`, `signalk_position` are created and repaired by the storage surface and receive the retention TTL from this surface.
- The stored context `self` for the own vessel, and the raw context string for other vessels, is the sampling-rate key here and the `context` column value written by the ingestion surface.
- Vessel-name identity rows use the path `name` and bypass the path filter but not the sampling rate; the ingestion surface defines how they are written.
- Object-valued deltas are filtered and throttled per flattened leaf path; the ingestion surface defines the flattening.
- The retention value applied here is re-applied by the storage surface after it rebuilds a table.
- The requirement that the plugin never claims the server's default history provider slot belongs to the lifecycle surface; this surface only guarantees the schema exposes no option for it.

## Disagreements with the README

None found.

## Observed defects

- A `samplingRates` entry with value `0` is ignored, so the matched path is throttled at `defaultSamplingRate` instead of written on every update, while `defaultSamplingRate` set to `0` does mean every update. Symptom: `{ "navigation.position": 0 }` with the default rate `2000` still writes `navigation.position` at most every 2000 ms.
- `pathFilter.mode` is not validated; any string other than exactly `exclude` selects include behaviour. Symptom: a hand-edited value such as `Exclude` or `excluded` silently flips the filter to include mode and stops recording every path not in the list.
- The effective value replaces only a missing or `null` value. Symptom: `questdbHost` saved as the empty string is used verbatim, and the plugin reports `QuestDB not responding at :9000` instead of trying `127.0.0.1`.
- A non-numeric `defaultSamplingRate` is not rejected. Symptom: a hand-edited `"abc"` writes every update of every path, with no log line and no status change.
- A non-numeric `retentionDays` is not rejected. Symptom: a hand-edited `"abc"` clears the TTL (`SET TTL 0h`) with no log line.

## Test cases

### Effective values at start

| Input / state                                                                                                 | Action | Expected outcome                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration with an unknown key and `recordSelf: true`; no `pathFilter`, no `samplingRates`                 | Start  | Effective `pathFilter` is `{ mode: "exclude", paths: [] }` and effective `samplingRates` is `{}`: every path is recorded and no override rate applies |
| `pathFilter: { mode: "include" }` with no `paths`                                                             | Start  | Effective `pathFilter` is `{ mode: "include", paths: [] }`: every path is recorded                                                                    |
| `pathFilter: { paths: ["navigation.*"] }` with no `mode`                                                      | Start  | Effective `pathFilter` is `{ mode: "exclude", paths: ["navigation.*"] }`: paths under `navigation.` are not recorded, every other path is             |
| `pathFilter: { mode: "include", paths: ["navigation.*"] }` and `samplingRates: { "environment.wind.*": 200 }` | Start  | Both values are used as stored                                                                                                                        |
| Configuration object `{ recordSelf: true }`                                                                   | Start  | The stored configuration is not rewritten; a later start receives the same object without `pathFilter` and derives the same effective values          |
| Configuration with an unknown key only; no `recordSelf`, no `recordOthers`                                    | Start  | Effective `recordSelf` is `true` and effective `recordOthers` is `true`: the own vessel and other vessels are recorded                                |
| `recordSelf: false` and `recordOthers: false`                                                                 | Start  | Both stay `false`: nothing is recorded                                                                                                                |

### Schema

| Input / state       | Action                           | Expected outcome                                    |
| ------------------- | -------------------------------- | --------------------------------------------------- |
| The plugin's schema | Inspect its top-level properties | No property named `promoteToDefaultProvider` exists |

### README configuration table

| Input / state                                  | Action                                                                                      | Expected outcome                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README `## Configuration` table and the schema | Compare each of the nine documented rows' `Default` cell with the schema default of its key | The row exists, and its cell equals the schema default rendered as `` `value` `` (strings bare, other values as JSON), or `_(empty)_` for an empty array |
| The schema                                     | Compare its leaf keys (descending into `pathFilter`) with the documented rows               | Every leaf key is one of the nine documented keys or is `samplingRates`; no other leaf key exists                                                        |
| The nine documented rows and the schema        | Compare each row's schema key `title` with the Admin UI title listed for the row            | They are equal                                                                                                                                           |
| README `## Configuration` table                | Compare its row labels with the nine documented labels                                      | Every row label is one of the nine documented labels; no other row exists                                                                                |
