# Ingestion: from server deltas to table rows

## Purpose

The plugin subscribes to the Signal K server's in-process stream of normalised deltas and records each delta as zero or more rows in three QuestDB tables. This surface decides which deltas are discarded, which vessel context string a row carries, which paths the operator's filter admits, how often a given path from a given vessel may produce a row, and which table a value of each kind lands in and in what form: a finite number becomes a numeric row, a string becomes a text row, a boolean becomes a tagged text row, a complete position under `navigation.position` becomes a track row, any other object is split one level deep into scalar leaves that are each recorded under a dotted path, and arrays, null and non-finite numbers are recorded nowhere. This surface never reads the delta's own timestamp; every row is stamped with the server receive time at the moment it is formed.

## Interface constants

### Configuration keys read by this surface

| Config key            | Admin UI title                   | README label                               | Type                       | Default   | Meaning                                                                                 |
| --------------------- | -------------------------------- | ------------------------------------------ | -------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `pathFilter.mode`     | `Filter mode`                    | `Path filter mode`                         | `"exclude"` or `"include"` | `exclude` | Whether matching paths are excluded or are the only ones included                       |
| `pathFilter.paths`    | `Path patterns (glob supported)` | `Path filter paths`                        | array of strings           | `[]`      | Filter patterns; empty records everything                                               |
| `defaultSamplingRate` | `Default sampling rate (ms)`     | `Sampling rate (ms)`                       | number                     | `2000`    | Minimum milliseconds between rows for one path from one vessel; `0` writes every update |
| `samplingRates`       | `Per-path sampling rates (ms)`   | (no README table row; documented in prose) | object, pattern to number  | `{}`      | Per-path override of `defaultSamplingRate`                                              |
| `recordSelf`          | `Record own vessel`              | `Record own vessel`                        | boolean                    | `true`    | Record the own vessel context                                                           |
| `recordOthers`        | `Record other vessels`           | `Record other vessels`                     | boolean                    | `true`    | Record every context other than the own vessel                                          |

Schema descriptions, verbatim:

| Config key            | Description string                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pathFilter.paths`    | `e.g. "notifications.*", "environment.wind.*"`                                                                                                                                             |
| `defaultSamplingRate` | `Minimum ms between writes for any path (0 = write every update). 2000ms is a sensible default for Pi-class hardware; lower it per-path via samplingRates when you need finer resolution.` |
| `samplingRates`       | `Override default rate for specific paths. e.g. { "environment.wind.*": 200, "tanks.*": 10000 }`                                                                                           |

README example for `samplingRates`, verbatim:

```json
{ "environment.wind.*": 200 }
```

### Tables and the columns each row form carries

| Table              | Row form    | Columns the row carries                                                                                                                    |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `signalk`          | numeric row | `ts` (TIMESTAMP), `path` (SYMBOL), `context` (SYMBOL), `source` (SYMBOL, nullable), `value` (DOUBLE)                                       |
| `signalk_str`      | text row    | `ts` (TIMESTAMP), `path` (SYMBOL), `context` (SYMBOL), `source` (SYMBOL, nullable), `value_str` (VARCHAR), `value_kind` (SYMBOL, nullable) |
| `signalk_position` | track row   | `ts` (TIMESTAMP), `context` (SYMBOL), `source` (SYMBOL, nullable), `lat` (DOUBLE), `lon` (DOUBLE)                                          |

`signalk_position` has no `path` column. The table DDL, partitioning, WAL mode and deduplication keys belong to the storage surface.

### Values of `value_kind`

| Value                             | Meaning                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| null (column absent from the row) | The recorded value was a string.                                                           |
| `boolean`                         | The recorded value was a boolean; `value_str` is `true` or `false`.                        |
| `identity`                        | The row is a vessel identity row written under path `name` (see "Vessel identity deltas"). |

### Other constants

| Constant                             | Value                                                                                           | Meaning                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Server stream                        | `app.streambundle.getBus()` called with no path argument                                        | The all-paths, all-contexts normalised delta bus                            |
| Delta fields read                    | `path`, `value`, `context`, `$source`                                                           | No other delta field is read                                                |
| Own vessel test                      | `context === app.selfContext`                                                                   | Strict string equality against the server's self context                    |
| Stored context for the own vessel    | `self`                                                                                          | Every row from the own vessel carries this context string                   |
| Stored context for any other context | the delta's `context` string, verbatim                                                          | For example `vessels.urn:mrn:imo:mmsi:244813000`                            |
| Identity report key                  | `name`                                                                                          | The key read from an empty-path object value                                |
| Identity row path                    | `name`                                                                                          | Path of the row produced from a vessel identity delta                       |
| Identity row kind tag                | `identity`                                                                                      | `value_kind` of the row produced from a vessel identity delta               |
| Track path                           | `navigation.position`                                                                           | The only path whose object values can produce a track row                   |
| Position object keys                 | `latitude`, `longitude`                                                                         | Both must be present and both must be finite numbers for a track row        |
| Boolean text forms                   | `true`, `false`                                                                                 | The `value_str` of a boolean row                                            |
| Glob metacharacter class             | `[*?[\]{}!+@()\|]` (the characters `*`, `?`, `[`, `]`, `{`, `}`, `!`, `+`, `@`, `(`, `)`, `\|`) | A pattern containing any of these is a glob; any other pattern is a literal |
| Glob semantics                       | `minimatch`, default options                                                                    | Semantics of glob patterns                                                  |
| Sampling gate entry cap              | `10000` (path, stored context) pairs                                                            | Ceiling on remembered last-write times                                      |
| Sampling clock                       | Wall clock in milliseconds at the moment the delta is processed                                 | Basis for every sampling window                                             |
| Leaf path form                       | `<parent path>.<key>`                                                                           | Path of a leaf produced from an object value; the separator is `.`          |

## Behaviour

### Subscription and lifecycle

1. The plugin subscribes to the server's all-paths delta bus only after startup has completed: QuestDB has answered, the tables exist, and the outbound write connection is established. Deltas that the server emits before that moment are never seen and are not recorded later.
2. Each delta from the bus is processed synchronously, in the order the server emits it.
3. The plugin reads `path`, `value`, `context` and `$source` from the delta. A delta whose `$source` is a non-empty string yields rows carrying that source; a delta whose `$source` is absent, not a string, or the empty string yields rows with no source. The plugin never reads `timestamp`, `source`, `state` or `isMeta`.
4. On stop, the plugin cancels its bus subscription. Deltas that arrive after stop began are discarded, not queued. A later start begins with empty sampling windows and no remembered vessel names. A configuration change takes effect because the server stops and restarts the plugin; the configuration in force is the one handed over at the most recent start.
5. The server hands over the stored configuration verbatim, and an older or hand-edited configuration can lack keys or hold `null`. The effective value of each key is:

   | Key                   | Stored value missing or `null`          | Any other stored value                                             |
   | --------------------- | --------------------------------------- | ------------------------------------------------------------------ |
   | `pathFilter`          | `mode` is `exclude` and `paths` is `[]` | Each of its two keys is resolved by the rows below                 |
   | `pathFilter.mode`     | `exclude`                               | The stored value (see "Path filter", rule 5)                       |
   | `pathFilter.paths`    | `[]`                                    | The stored value                                                   |
   | `samplingRates`       | `{}`                                    | The stored value                                                   |
   | `defaultSamplingRate` | `2000`                                  | The stored value (see "Sampling gate", rule 6)                     |
   | `recordSelf`          | `true`                                  | `false` when the stored value is exactly `false`; `true` otherwise |
   | `recordOthers`        | `true`                                  | `false` when the stored value is exactly `false`; `true` otherwise |

### Order of decisions for one delta

The steps below run in this order. The first step that discards the delta ends its processing.

1. Vessel identity check (see "Vessel identity deltas"). An identity delta never continues to the data steps, whether it produces a row or not.
2. Discard when `path` is empty or missing, or when `value` is `null` or `undefined`. `false`, `0` and `""` are values and are not discarded here.
3. Determine whether the delta is from the own vessel (`context === app.selfContext`). Discard an own-vessel delta when `recordSelf` is `false`. Discard any other delta when `recordOthers` is `false`. "Other" covers every non-self context, including `atons.*`, `aircraft.*` and `shore.*` contexts. A delta whose `context` is undefined or not a string is not the own vessel and is not discarded here (see "Observed defects").
4. Determine the value kind (see "Routing by kind"):
   - a finite number, a string, or a boolean is a scalar and produces at most one row;
   - an object at path exactly `navigation.position` that has `latitude` and `longitude` keys whose values are both finite numbers is a complete position and produces at most one track row;
   - any other non-null object that is not an array is split into leaves (see "Object values: one-level flattening");
   - a non-finite number (`NaN`, `Infinity`, `-Infinity`), an array (including an empty array), or anything else is discarded. This discard happens before the filter and before the sampling gate, so a discarded value does not open a sampling window.
5. For a scalar or a complete position: apply the path filter to `path`; discard when the filter rejects it. Then apply the sampling gate to (`path`, stored context); discard when the gate rejects it.
6. Compute the stored context: `self` for the own vessel, the delta's `context` verbatim otherwise.
7. The delta produces the row for its kind, in the table and form given under "Routing by kind", with the columns given under "Columns common to every row form". No row carries the delta's timestamp.

### Vessel identity deltas

A vessel identity delta is a delta whose `path` is the empty string `""` and whose `value` is a non-null object with a `name` property that is a string and is not empty after trimming whitespace. Other properties beside `name` (for example `mmsi`) are ignored. A delta with a non-empty path is never an identity delta, so a data path literally named `name` stays data and an object with a `name` property under a non-empty path is an ordinary object. An empty-path delta without a usable name is not an identity delta and is discarded by the empty-path rule; this covers an empty-path string, an empty-path null, an empty-path object without `name`, an empty-path object whose `name` is not a string, and an empty-path object whose `name` is empty or whitespace only.

1. The own-vessel test and the `recordSelf` / `recordOthers` toggles apply exactly as for data deltas. A disabled context discards the identity delta.
2. Identity deltas bypass the path filter. An include-mode filter that does not list `name` still records identity rows.
3. The plugin remembers the last name it recorded per stored context. When the remembered name for the stored context equals the delta's name, the delta is discarded. The sampling gate is not consulted and no sampling window is opened or updated.
4. After the outbound connection's disconnected-time buffer discards lines, the next identity report for every stored context is treated as new: its row is written again even when the name is unchanged, subject to rule 5.
5. Otherwise the sampling gate is applied to (`name`, stored context) with the rate resolved for the path `name` (a `samplingRates` entry keyed `name`, or a glob that matches `name`, or the default). When the gate rejects, the delta is discarded and the remembered name is not updated, so the next report of the same new name is attempted again.
6. When the gate admits, the plugin remembers the name for that stored context and writes one text row in `signalk_str`: `path` is `name`, `value_str` is the name string verbatim (not trimmed), `value_kind` is `identity`, `context` and `source` follow "Columns common to every row form".
7. The identity sampling window and a data delta at the literal path `name` from the same stored context share one (path, stored context) window.

### Path filter

1. Each pattern in `pathFilter.paths` is a literal when it contains none of the characters `* ? [ ] { } ! + @ ( ) |`, and a glob otherwise.
2. A literal matches a path only by exact string equality. A literal is never a prefix: `electrical.batteries.12v.name` does not match `electrical.batteries.12v.name.extra`.
3. A glob has `minimatch` default-option semantics. The consequences that matter for Signal K paths:
   - `*` matches any run of characters except `/`. Signal K paths contain no `/`, so `navigation.*` matches `navigation.gnss.satellites` as well as `navigation.position`. `navigation.*` does not match `navigation`, and `watch.*` does not match `watch`.
   - `?` matches one character except `/`.
   - `{a,b}` brace expansion, `[abc]` character classes and the extglob forms `+(…)`, `@(…)`, `!(…)`, `?(…)`, `*(…)` are available.
   - A pattern that begins with `!` negates the rest of the pattern.
   - A pattern that begins with `#` is a comment and matches nothing.
   - Matching is case-sensitive.
   - A path whose first character is `.` is not matched by a leading `*`.
4. A path matches the filter when it equals any literal or matches any glob. The answer for a given path is the same every time it is asked.
5. Semantics by mode:
   - `pathFilter.paths` empty (no literal and no glob): every path is recorded, in both modes.
   - `mode === "exclude"`: a path is recorded when it does not match.
   - any other mode value, including `include`: a path is recorded only when it matches. The mode string is not validated; every value other than exactly `exclude` behaves as `include`.

### Sampling rate resolution

1. An entry of `samplingRates` whose rate is not greater than `0` (zero, negative, or not a number) never matches any path. An entry is a literal or a glob by the same character class as the filter.
2. Resolution for a path: a literal entry equal to the path wins over every glob. When no literal equals the path, the glob entries are tried in the order the entries appear in the configuration object, and the first that matches wins. When nothing matches, the path uses `defaultSamplingRate` (or `2000` when that key is absent or `null`).
3. A non-positive entry therefore does not disable sampling for the paths it names; those paths fall through to the default. To write every update for a path, the operator sets `defaultSamplingRate` to `0`.
4. The resolved rate for a given path is the same every time it is asked.

### Sampling gate

1. The gate keeps one window per (path, stored context) pair. Two vessels updating the same path each have their own window; the own vessel's window is keyed by `self`. The source is not part of the key: with two receivers feeding one path, each window admits whichever receiver's update arrives first.
2. The clock is the server's wall clock in milliseconds at the time the delta is processed.
3. For a rate `r` and the pair's previous admit time `p` (`0` when the pair has never been admitted):
   - when `r <= 0`: admit, and record nothing;
   - when `t - p < r`, where `t` is the current time: reject; `p` is not updated, so a rejected update does not extend the window;
   - otherwise: admit and set `p = t`. An update exactly `r` milliseconds after the last admitted one is admitted.
4. The gate remembers at most `10000` pairs. When a pair not yet remembered is admitted while `10000` pairs are remembered, the gate first forgets every pair whose age (`t - p`) is at least the largest positive rate applied since the last start; when that leaves `10000` or more pairs, the gate forgets every pair. A forgotten pair is admitted immediately on its next update, even inside what would have been its window. Admitting an already-remembered pair never triggers this.
5. Stop forgets every pair.
6. A rate that is a numeric string in a hand-edited configuration (for example `defaultSamplingRate: "2000"`, or a `samplingRates` entry `"200"`) is compared as the number it denotes. A `defaultSamplingRate` that is neither a number nor a numeric string (for example `"abc"`) admits every update for the paths that use the default. A `samplingRates` entry whose rate is such a value never matches (rule 1 of "Sampling rate resolution").

### Routing by kind

The rules in this section apply to a value that has passed steps 1 to 6 of "Order of decisions for one delta", and to each leaf of an object value that has passed leaf gating (see "Object values: one-level flattening"). A value under the empty path never reaches these rules; it is either an identity delta or discarded.

#### Finite numbers

1. A value whose type is number and which is finite produces one numeric row in `signalk`: `path` is the delta path, `value` is the number as a DOUBLE.
2. Integers are not distinguished from other numbers. `3` lands as the DOUBLE `3.0`.

#### Non-finite numbers

3. A value that is `NaN`, `Infinity` or `-Infinity` produces no row in any table. QuestDB accepts these values over the wire and stores them, so the exclusion is this plugin's, applied before anything is sent.

#### Strings

4. A value whose type is string produces one text row in `signalk_str`: `path` is the delta path, `value_str` is the string verbatim, `value_kind` is null.
5. The empty string is a string value and produces a text row with an empty `value_str`.
6. A string whose text is `true` or `false` produces an untagged text row. It is not a boolean row and reads back as a string.

#### Booleans

7. A value whose type is boolean produces one text row in `signalk_str`: `path` is the delta path, `value_str` is `true` for true and `false` for false, `value_kind` is `boolean`.
8. Booleans never produce a numeric row. They are not stored as `0` and `1`.
9. Both history APIs read `value_kind` to turn `value_str` back into a boolean, so a recorded boolean reads back as a boolean and a recorded string `true` reads back as a string.

#### The position path

10. A value under path `navigation.position` that is an object (not null, not an array) with both a `latitude` property and a `longitude` property, where each is a finite number, produces one track row in `signalk_position`: `lat` is `latitude`, `lon` is `longitude`. No numeric row and no text row is produced for this value.
11. A property named `latitude` or `longitude` whose value is not a number (for example the string `"52.5"`) fails the finite-number test. A property whose value is `NaN`, `Infinity` or `-Infinity` fails it.
12. Any other property of a complete position object (for example `altitude`) is not recorded in any table.
13. A value under `navigation.position` that is an object but fails rule 10 (a coordinate missing, non-numeric or non-finite) is treated as any other object and flattened under "Object values: one-level flattening". Its usable leaves land under `navigation.position.latitude` and `navigation.position.longitude` in `signalk` (finite numbers) or `signalk_str` (strings). No track row is produced. A value under `navigation.position` that is null produces no row.
14. A position-shaped object under any path other than `navigation.position` (for example `navigation.anchor.position`, `navigation.courseGreatCircle.nextPoint.position`, `steering.autopilot.target.position`) never produces a track row. It is flattened: its coordinates land as numeric rows under `<path>.latitude` and `<path>.longitude`. The track table holds `navigation.position` rows exclusively, because it has no `path` column and its rows are keyed on `ts`, `context` and `source` only.
15. A finite number, string or boolean under `navigation.position` follows the rules for its kind; the path has no effect on scalar values.

#### Arrays

16. A value that is an array produces no row, whatever its length and whatever its elements. Array indices are not stable identities, so `foo.0` is not a path this plugin ever writes.

### Object values: one-level flattening

1. A value that is an object, not null, not an array, and not a complete `navigation.position` position, produces zero or more rows, one per scalar leaf. The parent path itself is neither filtered nor sampled, and no row is produced for the parent path in any table.
2. The leaf path is the parent path, `.`, and the key: the object `{roll: 0.02}` under `navigation.attitude` produces a row with path `navigation.attitude.roll`.
3. A leaf that is a finite number produces a numeric row in `signalk` under the leaf path.
4. A leaf that is a string produces a text row in `signalk_str` under the leaf path with `value_kind` null.
5. A leaf that is a boolean produces a text row in `signalk_str` under the leaf path with `value_str` `true` or `false` and `value_kind` `boolean`.
6. A leaf that is a non-finite number, a nested object, an array, null, undefined, or any other kind produces no row. Nested objects are not descended into: flattening is one level deep, and a payload such as a notification or a resource document loses everything below its first level.
7. An empty object produces no row.
8. Leaves are taken in the order the object's own enumerable string keys enumerate, and rows are written in that order.
9. A half position (for example `navigation.position` with only `latitude`, or with a non-finite or non-numeric coordinate) is an ordinary object: its usable leaves are recorded as `navigation.position.latitude` and `navigation.position.longitude`.
10. Every object at a path other than `navigation.position` that has `latitude` and `longitude` (for example `navigation.anchor.position`) is flattened the same way, into `<path>.latitude` and `<path>.longitude`.
11. Each leaf is gated independently, on the leaf path: the path filter is applied to the leaf path, then the sampling gate is applied to (leaf path, stored context) with the rate resolved for the leaf path. A rejected leaf is skipped; the remaining leaves are still processed. An exclusion of one leaf path excludes only that leaf.
12. Because only leaf paths are consulted, an include-mode filter listing `navigation.attitude.roll` records that leaf from a `navigation.attitude` object, and an exclude-mode filter listing the literal `navigation.attitude` does not exclude any of its leaves; `navigation.attitude.*` does.
13. Each admitted leaf produces exactly the row a top-level scalar delta at the leaf path would produce. Leaf rows share sampling windows with top-level scalar deltas at the same path and stored context.
14. An object under the empty path is never flattened (it is an identity delta or is discarded). No row is ever written under a path that begins with `.`.

### Columns common to every row form

1. `ts` is the server receive time, assigned when the row is formed, not the timestamp the delta carries. Two rows formed in the same millisecond receive distinct `ts` values at microsecond resolution. The ILP wire format surface specifies the clock. Because sampling windows also measure the server clock, a source whose own clock is wrong is recorded and sampled at the configured rate regardless.
2. `context` is `self` when the delta context is the server's own vessel context, and the delta context string verbatim otherwise. Every row form carries it.
3. `source` is the delta's `$source` string when the delta carries a non-empty one. Otherwise the row has no `source` tag and the column reads back null. Every row form carries it.
4. `path` is the delta path (scalars), the leaf path (flattened objects), or `name` (identity rows). The track row form has no `path`.

## Cross-surface references

- Table names `signalk`, `signalk_str`, `signalk_position` and their column names are the storage surface's DDL; this surface names them as the destinations of each row form.
- Stored context strings: `self` for the own vessel, verbatim `context` for every other context. Rows carry the normalised value; history readers and replay depend on it.
- `value_kind` values `boolean` and `identity`, and null for plain strings, are written by this surface and read by the history v1 and history v2 surfaces to decode `value_str`.
- Identity rows: path `name`, `value_kind` `identity`, in `signalk_str`; history v1 replay reconstructs the empty-path identity delta from them.
- Source: the delta's non-empty `$source` string, or absent, becomes the rows' `source` column; absent means a null column.
- Timestamp: assigned by the ILP wire format surface as the current server time when the row is formed, never the delta's `timestamp`; distinct at microsecond resolution.
- After the outbound connection's disconnected-time buffer discards lines (ILP wire format surface), the next identity report per stored context is written again even when unchanged.
- `navigation.position` as the sole track path is relied on by the history v1 surface, which reconstructs `navigation.position` deltas from `signalk_position` rows without a `path` column.
- The wire form of each row (ILP line shape, tag and field escaping) is the ILP wire format surface's.
- Startup ordering: subscription starts only after tables exist and the write connection is up (plugin lifecycle surface); status strings `Waiting for QuestDB to become ready...`, `Creating tables...` and `Recording to QuestDB at <host>:<port>` precede the first row.
- Configuration keys, defaults and effective values above are shared with the configuration surface and the README configuration table.

## Disagreements with the README

- README, `Sampling rate (ms)` row: "Default min ms between writes per path". The code applies the rate per path and per vessel context: two vessels reporting the same path inside one window both produce a row.
- README, `Per-path sampling rates (ms)`: "a JSON object mapping a glob pattern to an interval". The code also accepts exact path patterns, and an exact pattern wins over a glob that matches the same path. The README does not say that a non-positive interval is ignored and falls back to the default rather than disabling sampling for that path.
- README, `Path filter paths` row: "Glob patterns, one per line". A pattern with no glob metacharacter is matched by exact equality, not as a prefix; the README does not state this.
- The README says the plugin records "positions" and describes `signalk_position` as holding "Positions", without limiting which path. The code writes a track row only for `navigation.position`; a position-shaped object under any other path is flattened into numeric rows under `<path>.latitude` and `<path>.longitude`.
- The README's introduction lists "the scalar leaves of object values" without stating the depth. The code flattens one level only; nested objects are dropped.

## Observed defects

- `pathFilter.mode` is not validated: any value other than exactly `exclude` (for example `Exclude` or `excluded` in a hand-edited configuration) behaves as `include`, and with a non-empty pattern list records only matching paths.
- Meta deltas are not distinguished from value deltas: the all-paths bus also carries meta updates, whose object values are flattened into leaves, so rows such as `<path>.units` or `<path>.description` appear in history whenever a meta update arrives for a path.
- A literal exclude pattern naming an object-valued path (for example `navigation.attitude`) excludes nothing, because only leaf paths are filtered; the leaves `navigation.attitude.roll` and siblings are still recorded.
- Sampling windows measure the raw wall clock: after the system clock steps backwards, every pair whose previous admit time plus its rate is later than the new clock time rejects every update, whatever the length of its window, until the clock passes that previous admit time plus the rate. A pair whose previous admit time is later than the clock has a negative age, so the cap sweep never forgets it; only a full forget or a stop releases it.
- A data delta at the literal path `name` and an identity report from the same stored context share one sampling window and suppress each other inside it.
- A delta whose `context` is undefined or not a string is not discarded. When it would otherwise produce a row (an identity row, a scalar row, a track row, or the first admitted leaf), the plugin throws a `TypeError` out of its delta subscription callback into the server's stream, and no row is written for that delta. For a data delta, the sampling window for (path, the missing context) has already been opened, so a repeat inside the window is discarded silently and the next one after the window throws again. For an identity delta, the name is remembered for the missing context before the throw, so a repeat of the same name is deduplicated and never throws again; only a different name throws again, after the `name` window for the missing context has passed.
- A complete position under `navigation.position` that also carries `altitude` (or any other property) records `lat` and `lon` only; the extra property is recorded in no table and is absent from every history read.
- An empty-path identity report that carries `mmsi` but no usable `name` (for example `{mmsi: "244813000"}`) records nothing; `mmsi` and every other identity property except `name` are never recorded from any identity report.

## Test cases

### Path filter matching

| Input / state                                                                                                                                                         | Action                                                                                                                                                                                                                                                                                                               | Expected outcome                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patterns `["electrical.batteries.12v.name"]`                                                                                                                          | Test `electrical.batteries.12v.name`                                                                                                                                                                                                                                                                                 | Matches                                                                                                                                                                                                                                                                                                                          |
| Patterns `["electrical.batteries.12v.name"]`                                                                                                                          | Test `electrical.batteries.12v.voltage`                                                                                                                                                                                                                                                                              | Does not match                                                                                                                                                                                                                                                                                                                   |
| Patterns `["electrical.batteries.12v.name"]`                                                                                                                          | Test `electrical.batteries.12v.name.extra`                                                                                                                                                                                                                                                                           | Does not match; a literal is not a prefix                                                                                                                                                                                                                                                                                        |
| Patterns `["navigation.gnss.*", "environment.*.temperature"]`                                                                                                         | Test `navigation.gnss.satellites`                                                                                                                                                                                                                                                                                    | Matches                                                                                                                                                                                                                                                                                                                          |
| Patterns `["navigation.gnss.*", "environment.*.temperature"]`                                                                                                         | Test `navigation.speedOverGround`                                                                                                                                                                                                                                                                                    | Does not match                                                                                                                                                                                                                                                                                                                   |
| Patterns `["navigation.gnss.*", "environment.*.temperature"]`                                                                                                         | Test `environment.water.temperature`                                                                                                                                                                                                                                                                                 | Matches                                                                                                                                                                                                                                                                                                                          |
| Patterns `[]`, mode `include`                                                                                                                                         | Deltas at `navigation.position` and `a.b` arrive                                                                                                                                                                                                                                                                     | Both recorded; an empty list records everything                                                                                                                                                                                                                                                                                  |
| Patterns `[]`, mode `exclude`                                                                                                                                         | Deltas at `navigation.position` and `a.b` arrive                                                                                                                                                                                                                                                                     | Both recorded                                                                                                                                                                                                                                                                                                                    |
| Patterns `["a.b"]`, mode `include`                                                                                                                                    | Deltas at `a.b` and `a.c` arrive                                                                                                                                                                                                                                                                                     | `a.b` recorded, `a.c` not recorded                                                                                                                                                                                                                                                                                               |
| Patterns `["a.*"]`, mode `exclude`                                                                                                                                    | Deltas at `a.b` and `b.a` arrive                                                                                                                                                                                                                                                                                     | `a.b` not recorded, `b.a` recorded                                                                                                                                                                                                                                                                                               |
| Patterns `["design.*", "electrical.batteries.12v.name", "navigation.gnss.*", "environment.*.temperature", "tanks.fuel.*.currentLevel", "watch.*", "notifications.*"]` | Test each of `design.aisShipType`, `electrical.batteries.12v.name`, `electrical.batteries.12v.voltage`, `navigation.gnss.satellites`, `navigation.speedOverGround`, `environment.water.temperature`, `environment.inside.engineRoom.temperature`, `tanks.fuel.0.currentLevel`, `watch`, `watch.x`, `design`, `a.b.c` | Matches: `design.aisShipType`, `electrical.batteries.12v.name`, `navigation.gnss.satellites`, `environment.water.temperature`, `environment.inside.engineRoom.temperature`, `tanks.fuel.0.currentLevel`, `watch.x`. Does not match: `electrical.batteries.12v.voltage`, `navigation.speedOverGround`, `watch`, `design`, `a.b.c` |

### Sampling rate resolution

| Input / state                                         | Action                                      | Expected outcome                                       |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| Rates `{"navigation.position": 500}`                  | Resolve `navigation.position`               | `500`                                                  |
| Rates `{"navigation.position": 500}`                  | Resolve `navigation.speedOverGround`        | The default rate                                       |
| Rates `{"environment.wind.*": 200}`                   | Resolve `environment.wind.speedApparent`    | `200`                                                  |
| Rates `{"environment.wind.*": 200}`                   | Resolve `environment.water.temperature`     | The default rate                                       |
| Rates `{"a.*": 0, "b.*": -1, "c.*": 100}`             | Resolve `a.x`, `b.x`, `c.x`                 | The default rate, the default rate, `100`              |
| Rates `{"tanks.*": 10000, "tanks.fuel.0.level": 250}` | Resolve `tanks.fuel.0.level`                | `250`; the literal wins over the glob                  |
| Rates `{"tanks.*": 10000, "tanks.fuel.0.level": 250}` | Resolve `tanks.water.0.level`               | `10000`                                                |
| Rates `{}`                                            | Resolve any path                            | The default rate                                       |
| Rates `{"a.*": 0}`                                    | Resolve `a.x`                               | The default rate; the non-positive entry never matches |
| Rates `{"a.*": 5}`                                    | Resolve `a.x`                               | `5`                                                    |
| Rates `{"environment.wind.*": 200}`, default `2000`   | Effective rate for `environment.wind.angle` | `200`                                                  |
| Rates `{"environment.wind.*": 200}`, default `2000`   | Effective rate for `navigation.position`    | `2000`                                                 |
| Rates `{"navigation.*": 0}`, default `2000`           | Effective rate for `navigation.position`    | `2000`; a zero override does not disable sampling      |

### Sampling gate

| Input / state                                                          | Action                                                                                              | Expected outcome                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Empty gate, rate `2000`                                                | `navigation.position` from `vessels.a` at `T0`, from `vessels.b` at `T0+10`, from `self` at `T0+20` | All three admitted; windows are per path and context                                              |
| Empty gate, rate `2000`                                                | `a.b` from `self` at `T0`, `T0+1999`, `T0+2000`                                                     | Admitted, rejected, admitted                                                                      |
| `a.b`/`self` admitted at `T0`, rate `2000`                             | Same pair at `T0+1500`, then at `T0+2100`                                                           | Rejected, then admitted; the rejection did not move the window                                    |
| Empty gate                                                             | `a.b`/`self` with rate `0` at `T0` and `T0+1`, then rate `-5` at `T0+2`                             | All admitted; a non-positive rate never rejects                                                   |
| `a.b`/`self` admitted at `T0`, rate `2000`                             | Stop the plugin, start it, then same pair at `T0+1`                                                 | Admitted; a start begins with empty windows                                                       |
| Rate `2000`, `10000` distinct pairs `p`/`vessels.<i>` admitted at `T0` | `p`/`vessels.new` at `T0+2500`                                                                      | Admitted                                                                                          |
| Rate `2000`, `10000` distinct pairs `p`/`vessels.<i>` admitted at `T0` | `p`/`vessels.new` at `T0+100`, then `p`/`vessels.1` at `T0+200`                                     | Both admitted; every earlier pair was forgotten, so `p`/`vessels.1` is admitted inside its window |

### Configuration normalisation

| Input / state                                                                                                                    | Action                                                                     | Expected outcome                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Stored config with no `pathFilter` and no `samplingRates`                                                                        | Start; deltas at `navigation.position` and `environment.wind.angle` arrive | Both recorded; both sampled at `defaultSamplingRate`                                           |
| Stored config with `pathFilter: { mode: "include" }` only                                                                        | Start; deltas at `navigation.position` and `a.b` arrive                    | Both recorded; an include mode with an empty list records everything                           |
| Stored config with `pathFilter: { paths: ["navigation.*"] }` only                                                                | Start; deltas at `navigation.position` and `a.b` arrive                    | `navigation.position` not recorded, `a.b` recorded; the mode is `exclude`                      |
| Stored config with `pathFilter: { mode: "include", paths: ["navigation.*"] }` and `samplingRates: { "environment.wind.*": 200 }` | Start; deltas at `navigation.position` and `a.b` arrive                    | `navigation.position` recorded, `a.b` not recorded; `environment.wind.*` paths sample at `200` |
| Stored config with neither `recordSelf` nor `recordOthers`                                                                       | Start; one own-vessel delta and one `vessels.a` delta arrive               | Both recorded                                                                                  |
| Stored config with `recordSelf: false` and `recordOthers: false`                                                                 | Start; one own-vessel delta and one `vessels.a` delta arrive               | Neither recorded                                                                               |

### Vessel identity deltas

| Input / state                                                        | Action        | Expected outcome                                                                                                                  |
| -------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Delta `path: ""`, `value: { name: "Sea Breeze" }`                    | Delta arrives | Identity delta with name `Sea Breeze`; one row in `signalk_str`: `path` `name`, `value_str` `Sea Breeze`, `value_kind` `identity` |
| Delta `path: ""`, `value: { name: "Sea Breeze", mmsi: "244813000" }` | Delta arrives | Identity delta with name `Sea Breeze`; `mmsi` is not recorded; no row under `.name`, `.mmsi` or any other dotted leaf path        |
| Delta `path: "name"`, `value: "Sea Breeze"`                          | Delta arrives | Not an identity delta; one row in `signalk_str`: `path` `name`, `value_str` `Sea Breeze`, `value_kind` null                       |
| Delta `path: "navigation.state"`, `value: { name: "x" }`             | Delta arrives | Not an identity delta; one row in `signalk_str`: `navigation.state.name`, `value_str` `x`, `value_kind` null                      |
| Delta `path: ""`, `value: { mmsi: "244813000" }`                     | Delta arrives | Not an identity delta; discarded as empty path; no row in any table                                                               |
| Delta `path: ""`, `value: { name: "" }`                              | Delta arrives | Not an identity delta; discarded; no row in any table                                                                             |
| Delta `path: ""`, `value: { name: "   " }`                           | Delta arrives | Not an identity delta; discarded; no row in any table                                                                             |
| Delta `path: ""`, `value: { name: 42 }`                              | Delta arrives | Not an identity delta; discarded; no row in any table                                                                             |
| Delta `path: ""`, `value: null`                                      | Delta arrives | Not an identity delta; discarded; no row in any table                                                                             |
| Delta `path: ""`, `value: "just a string"`                           | Delta arrives | Not an identity delta; discarded; no row in any table                                                                             |

### Routing by kind

| Input / state                                                                                        | Action        | Expected outcome                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path `environment.depth.belowKeel`, value `4.2`                                                      | Delta arrives | One row in `signalk`: `path` `environment.depth.belowKeel`, `value` `4.2`. No row in `signalk_str` or `signalk_position`.                                                       |
| Path `watermaker.brineomatic.high_pressure_pump_on`, value `true`                                    | Delta arrives | One row in `signalk_str`: `value_str` `true`, `value_kind` `boolean`. No row in `signalk`.                                                                                      |
| Path `electrical.switches.bilgePump.state`, value `false`                                            | Delta arrives | One row in `signalk_str`: `value_str` `false`, `value_kind` `boolean`. No row in `signalk`.                                                                                     |
| Path `navigation.state`, value `"anchored"`                                                          | Delta arrives | One row in `signalk_str`: `value_str` `anchored`, `value_kind` null.                                                                                                            |
| Path `navigation.position`, value `{latitude: 52.5, longitude: 13.4}`                                | Delta arrives | One row in `signalk_position`: `lat` `52.5`, `lon` `13.4`. No row in `signalk` or `signalk_str`.                                                                                |
| Path `navigation.anchor.position`, value `{latitude: 12.05, longitude: -61.75}`                      | Delta arrives | Two rows in `signalk`: `navigation.anchor.position.latitude` `12.05`, `navigation.anchor.position.longitude` `-61.75`, in that order. No row in `signalk_position`.             |
| Path `navigation.courseGreatCircle.nextPoint.position`, value `{latitude: 12.05, longitude: -61.75}` | Delta arrives | Two rows in `signalk` under `navigation.courseGreatCircle.nextPoint.position.latitude` and `.longitude`. No row in `signalk_position`.                                          |
| Path `steering.autopilot.target.position`, value `{latitude: 12.05, longitude: -61.75}`              | Delta arrives | Two rows in `signalk` under `steering.autopilot.target.position.latitude` and `.longitude`. No row in `signalk_position`.                                                       |
| Path `navigation.position`, value `{latitude: 1}`                                                    | Delta arrives | One row in `signalk`: `navigation.position.latitude` `1`. No row in `signalk_position`.                                                                                         |
| Path `navigation.attitude`, value `{roll: 0.1, pitch: 0}`                                            | Delta arrives | Two rows in `signalk`: `navigation.attitude.roll` `0.1`, `navigation.attitude.pitch` `0`.                                                                                       |
| Path `navigation.position`, value `null`                                                             | Delta arrives | No row in any table.                                                                                                                                                            |
| Path `navigation.position`, value `{latitude: NaN, longitude: 13.4}`                                 | Delta arrives | One row in `signalk`: `navigation.position.longitude` `13.4`. No row for `latitude`. No row in `signalk_position`.                                                              |
| Path `navigation.position`, value `{latitude: "52.5", longitude: 13.4}`                              | Delta arrives | One row in `signalk_str`: `navigation.position.latitude` `52.5`, `value_kind` null. One row in `signalk`: `navigation.position.longitude` `13.4`. No row in `signalk_position`. |
| Path `navigation.position`, value `{latitude: 52.5, longitude: Infinity}`                            | Delta arrives | One row in `signalk`: `navigation.position.latitude` `52.5`. No row for `longitude`. No row in `signalk_position`.                                                              |
| Path `environment.depth.belowKeel`, value `NaN`                                                      | Delta arrives | No row in any table.                                                                                                                                                            |
| Path `environment.depth.belowKeel`, value `Infinity`                                                 | Delta arrives | No row in any table.                                                                                                                                                            |
| Path `environment.depth.belowKeel`, value `-Infinity`                                                | Delta arrives | No row in any table.                                                                                                                                                            |
| Path `some.list`, value `[1, 2, 3]`                                                                  | Delta arrives | No row in any table.                                                                                                                                                            |
| Path `some.list`, value `[]`                                                                         | Delta arrives | No row in any table.                                                                                                                                                            |

### Flattening objects

| Input / state                                                                                                           | Action        | Expected outcome                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Path `navigation.attitude`, value `{roll: 0.02, pitch: -0.01, yaw: 1.57}`                                               | Delta arrives | Three rows in `signalk`, in this order: `navigation.attitude.roll` `0.02`, `navigation.attitude.pitch` `-0.01`, `navigation.attitude.yaw` `1.57`. No row under `navigation.attitude`.                                                      |
| Path `some.thing`, value `{count: 3, label: "port", active: true}`                                                      | Delta arrives | `signalk`: `some.thing.count` `3`. `signalk_str`: `some.thing.label` `value_str` `port`, `value_kind` null. `signalk_str`: `some.thing.active` `value_str` `true`, `value_kind` `boolean`. Rows written in the order count, label, active. |
| Path `sensor.x`, value `{good: 1.5, bad: NaN, worse: Infinity}`                                                         | Delta arrives | One row in `signalk`: `sensor.x.good` `1.5`. No row for `bad` or `worse`.                                                                                                                                                                  |
| Path `a.b`, value `{flat: 1, nested: {deep: 2}, list: [1, 2]}`                                                          | Delta arrives | One row in `signalk`: `a.b.flat` `1`. No row for `nested`, `nested.deep` or `list`.                                                                                                                                                        |
| Path `a.b`, value `{present: 1, empty: null, missing: undefined}`                                                       | Delta arrives | One row in `signalk`: `a.b.present` `1`. No row for `empty` or `missing`.                                                                                                                                                                  |
| Path `a.b`, value `{}`                                                                                                  | Delta arrives | No row in any table.                                                                                                                                                                                                                       |
| Path `a.b`, value `[1, 2]`                                                                                              | Delta arrives | No row in any table.                                                                                                                                                                                                                       |
| Path `navigation.anchor.position`, value `{latitude: 12.05, longitude: -61.75}`                                         | Delta arrives | Two rows in `signalk`, in this order: `navigation.anchor.position.latitude` `12.05`, `navigation.anchor.position.longitude` `-61.75`. No row in `signalk_position`.                                                                        |
| Mode `include`, patterns `["navigation.attitude.roll"]`; path `navigation.attitude`, value `{roll: 0.02, pitch: -0.01}` | Delta arrives | One row in `signalk`: `navigation.attitude.roll` `0.02`. No row for `pitch`.                                                                                                                                                               |
| Mode `exclude`, patterns `["navigation.attitude"]`; path `navigation.attitude`, value `{roll: 0.02, pitch: -0.01}`      | Delta arrives | Two rows in `signalk`: `navigation.attitude.roll` `0.02`, `navigation.attitude.pitch` `-0.01`; the literal parent path excludes no leaf.                                                                                                   |
