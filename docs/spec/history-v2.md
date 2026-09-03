# History API v2 provider

## Purpose

The plugin registers one History API provider with the Signal K server through `app.registerHistoryApiProvider()`. The server parses `GET /signalk/v2/api/history/values`, `/paths` and `/contexts` requests and calls the provider's `getValues`, `getPaths` and `getContexts` methods with typed request objects. For each request the provider turns the parameters into one or more SQL statements against the three QuestDB tables the plugin writes (`signalk`, `signalk_str`, `signalk_position`), and turns the row sets that come back into the response shapes the server API defines. Numeric aggregation over time buckets is done by QuestDB with `SAMPLE BY`; the moving-average aggregates and the middle-index aggregate are computed by the provider over raw rows.

## Interface constants

### Server API surface

| Item                                      | Value                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration call                         | `app.registerHistoryApiProvider(provider)`                                                                                                                      |
| Provider methods                          | `getValues(query)`, `getPaths(query)`, `getContexts(query)` — each returns a promise                                                                            |
| Own-vessel identity                       | The server's self context string as exposed to plugins (for example `vessels.urn:mrn:imo:mmsi:123456789`), supplied once at registration time                   |
| Server API package that defines the types | `@signalk/server-api`: `ValuesRequest`, `ValuesResponse`, `PathSpec`, `PathsRequest`, `PathsResponse`, `ContextsRequest`, `ContextsResponse`, `AggregateMethod` |

### Request and response shapes (as the server API defines them)

`getValues` request:

| Field        | Type                                                                                             | Meaning                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`       | `Temporal.Instant` (optional)                                                                    | Range start                                                                                                                                                                                               |
| `to`         | `Temporal.Instant` (optional)                                                                    | Range end                                                                                                                                                                                                 |
| `duration`   | `Temporal.Duration` or seconds as a number (optional)                                            | Range length                                                                                                                                                                                              |
| `context`    | string (optional)                                                                                | Signal K context; absent means the own vessel                                                                                                                                                             |
| `resolution` | number (optional)                                                                                | Bucket length in seconds; absent, `0` or negative means raw rows                                                                                                                                          |
| `pathSpecs`  | array of `{ path: string, aggregate: AggregateMethod, parameter: string[], sourceRef?: string }` | One entry per requested column, in request order. The server builds these from the `paths=` query parameter, one expression per path: `<path>[:<aggregate>[:<parameter>]][\|<sourceRef>]`, with no spaces |

`getValues` response:

| Field     | Type                                                            | Meaning                                                                                                                                                |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `context` | string                                                          | The context string the request carried, or `vessels.self` when the request had none                                                                    |
| `range`   | `{ from: string, to: string }`                                  | The resolved range as ISO 8601 instants, exactly as Behaviour 2 resolves them                                                                          |
| `values`  | array of `{ path: string, method: string, sourceRef?: string }` | One entry per path specification, in request order; `sourceRef` present only when the specification carried a non-empty one                            |
| `data`    | array of `[timestamp: string, ...value]`                        | One row per distinct timestamp, ascending; one value per path specification after the timestamp, `null` where that column has no row at that timestamp |

`getPaths` and `getContexts` requests carry only `from`, `to` and `duration`. `getPaths` returns an array of path strings. `getContexts` returns an array of context strings.

### Time range

| Constant                                      | Value                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Resolved range                                | Object with string properties `from` and `to`                                                             |
| Resolved string format                        | `Temporal.Instant` ISO 8601 text: `YYYY-MM-DDTHH:mm:ss[.fraction]Z`                                       |
| Default `to` when only `from` is given        | The current instant, sampled once per request                                                             |
| Error text for an unresolvable request        | `Invalid time range: provide at least from or duration`                                                   |
| Server-side duration syntax on the REST route | ISO 8601 duration string (for example `PT5M`, `PT1H`) or a non-negative decimal integer number of seconds |
| SQL predicate boundary format                 | `YYYY-MM-DDTHH:mm:ss.sssZ` (exactly three fractional digits)                                              |

### Aggregate names

| `aggregate`                     | SQL expression in sampled numeric queries                                 | Where computed |
| ------------------------------- | ------------------------------------------------------------------------- | -------------- |
| `average`                       | `avg(value)`                                                              | QuestDB        |
| `min`                           | `min(value)`                                                              | QuestDB        |
| `max`                           | `max(value)`                                                              | QuestDB        |
| `first`                         | `first(value)`                                                            | QuestDB        |
| `last`                          | `last(value)`                                                             | QuestDB        |
| `mid`                           | `(min(value) + max(value)) / 2`                                           | QuestDB        |
| any other name not listed below | `avg(value)`                                                              | QuestDB        |
| `sma`                           | none — raw rows read, simple moving average computed by the provider      | provider       |
| `ema`                           | none — raw rows read, exponential moving average computed by the provider | provider       |
| `middle_index`                  | none — raw rows read, one value kept at the middle index                  | provider       |

### Client-side aggregate parameters

| Item                        | Value                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| `sma` window default        | `5`                                                                    |
| `sma` window accepted range | an integer `>= 1`                                                      |
| `ema` alpha default         | `0.2`                                                                  |
| `ema` alpha accepted range  | `0 < alpha <= 1`                                                       |
| Parameter source            | `parameter[0]` of the path specification; further elements are ignored |

### Limits

| Item                                              | Value         |
| ------------------------------------------------- | ------------- |
| Maximum fabricated sample buckets per request     | `1000000`     |
| Minimum effective `SAMPLE BY` period              | `1` second    |
| Raw-row limit, numeric, string and position reads | `LIMIT 10000` |
| Raw-row limit, client-side aggregate reads        | `LIMIT 50000` |

### Tables and columns read

| Table              | Columns used                                                 |
| ------------------ | ------------------------------------------------------------ |
| `signalk`          | `ts`, `path`, `context`, `source`, `value`                   |
| `signalk_str`      | `ts`, `path`, `context`, `source`, `value_str`, `value_kind` |
| `signalk_position` | `ts`, `context`, `source`, `lat`, `lon`                      |

### Fixed strings

| Item                                                  | Value                                   |
| ----------------------------------------------------- | --------------------------------------- |
| Own-vessel context as callers send it                 | `vessels.self`                          |
| Own-vessel context alias also accepted                | `self`                                  |
| Own-vessel context as stored in every table           | `self`                                  |
| Path served from the position table                   | `navigation.position`                   |
| Position value shape in `data`                        | `{ latitude: <lat>, longitude: <lon> }` |
| `value_kind` marker for recorded booleans             | `boolean`                               |
| Boolean text stored in `value_str`                    | `true` and `false`                      |
| `method` reported for a downsampled string column     | `last`                                  |
| Safe identifier pattern (contexts, paths, sourceRefs) | `^[a-zA-Z0-9_.:-]+$`                    |
| Result column alias, sampled numeric query            | `agg_value`                             |
| Result column aliases, sampled position query         | `lat`, `lon`                            |
| Result column aliases, sampled string query           | `value_str`, `value_kind`               |

### Error strings

| Condition                                                    | Error message (thrown; the promise rejects)                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context, path or sourceRef fails the safe identifier pattern | `Invalid identifier: <value>`                                                                                                                                                                                                                                                                                     |
| A resolved range boundary is not a parseable date            | `Invalid timestamp: <value>`                                                                                                                                                                                                                                                                                      |
| Sample bucket guard trips                                    | `resolution <resolution>s over this range produces up to <buckets> sample buckets across <sampled> paths (max 1000000) — use a coarser resolution or a shorter range` (the dash is U+2014 EM DASH; `<resolution>` is the requested value before rounding; `<buckets>` and `<sampled>` are defined in Behaviour 3) |
| None of `from` and `duration` is present                     | `Invalid time range: provide at least from or duration` (an `Error`)                                                                                                                                                                                                                                              |
| Numeric `duration` is not an integer                         | A `RangeError` raised by the Temporal implementation in use when it builds a duration from a fractional number of seconds; the current text is `unsupported fractional value <value>`                                                                                                                             |
| Numeric `duration` is `NaN`                                  | A `RangeError` raised by the Temporal implementation in use; the current text is `not a number`                                                                                                                                                                                                                   |
| `duration` carries a calendar component                      | A `RangeError` raised by the Temporal implementation in use when it adds the duration to an instant; the current text is `Duration field <field> not supported by Temporal.Instant. Try Temporal.ZonedDateTime instead.` where `<field>` is `day`, `week`, `month` or `year`                                      |
| QuestDB rejects or fails a query                             | The query execution error, unchanged                                                                                                                                                                                                                                                                              |

### SQL shapes

Placeholders: `<from>` and `<to>` are the resolved range boundaries normalised to millisecond ISO 8601 with a `Z` suffix (for example `2024-01-01T00:00:00.000Z`); `<context>` is the stored context; `<path>` is the requested path; `<src>` is the empty string, or ` AND source = '<sourceRef>'` (leading space included) when the specification carries a sourceRef; `<R>` is the effective resolution in whole seconds; `<AGG>` is the SQL expression from the aggregate table; `<POS>` is `first` or `last`.

| Id                      | Statement                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| W0                      | `ts >= '<from>' AND ts <= '<to>'`                                                                                                           |
| W1                      | `ts >= '<from>' AND ts <= '<to>' AND context = '<context>'`                                                                                 |
| W2                      | `ts >= '<from>' AND ts <= '<to>' AND context = '<context>' AND path = '<path>'<src>`                                                        |
| Q1 sampled numeric      | `SELECT ts, <AGG> as agg_value FROM signalk WHERE <W2> SAMPLE BY <R>s FILL(NULL) ORDER BY ts`                                               |
| Q2 raw numeric          | `SELECT ts, value FROM signalk WHERE <W2> ORDER BY ts LIMIT 10000`                                                                          |
| Q3 client-side raw read | `SELECT ts, value FROM signalk WHERE <W2> ORDER BY ts LIMIT 50000`                                                                          |
| Q4 sampled string       | `SELECT ts, last(value_str) as value_str, last(value_kind) as value_kind FROM signalk_str WHERE <W2> SAMPLE BY <R>s FILL(NULL) ORDER BY ts` |
| Q5 raw string           | `SELECT ts, value_str, value_kind FROM signalk_str WHERE <W2> ORDER BY ts LIMIT 10000`                                                      |
| Q6 sampled position     | `SELECT ts, <POS>(lat) as lat, <POS>(lon) as lon FROM signalk_position WHERE <W1><src> SAMPLE BY <R>s FILL(NULL) ORDER BY ts`               |
| Q7 raw position         | `SELECT ts, lat, lon FROM signalk_position WHERE <W1><src> ORDER BY ts LIMIT 10000`                                                         |
| Q8 paths                | see below                                                                                                                                   |
| Q9 contexts             | see below                                                                                                                                   |

Q8 and Q9 are each sent as one statement string. Surrounding whitespace and line breaks are not significant: QuestDB ignores them, and an implementation may send each statement on one line.

Q8:

```sql
SELECT DISTINCT path FROM signalk WHERE <W0>
UNION
SELECT DISTINCT path FROM signalk_str WHERE <W0>
UNION
SELECT DISTINCT 'navigation.position' path FROM signalk_position WHERE <W0>
ORDER BY path
```

Q9:

```sql
SELECT DISTINCT context FROM signalk WHERE <W0>
UNION
SELECT DISTINCT context FROM signalk_str WHERE <W0>
UNION
SELECT DISTINCT context FROM signalk_position WHERE <W0>
ORDER BY context
```

## Behaviour

### 1. Registration

1. The provider is registered with `app.registerHistoryApiProvider()` once the QuestDB connection and tables are ready. The lifecycle surface defines when that is.
2. The provider object carries exactly the three methods `getValues`, `getPaths` and `getContexts`.
3. The provider keeps the server's self context string. It uses that string only to recognise a request for the own vessel (Behaviour 4).

### 2. Time range resolution

Every request (`getValues`, `getPaths`, `getContexts`) carries a time window as some combination of `from`, `to` and `duration`. Each method first resolves that combination into one absolute range of two ISO 8601 UTC instant strings, `from` and `to`, before it validates anything else or issues any SQL. The resolved range bounds every database query the request issues, and the `getValues` response echoes it back verbatim. The history v1 surface does not use this resolution; it takes `startTime` directly.

#### Where the inputs come from

1. On the REST route (`/signalk/v2/api/history/values`, `/paths`, `/contexts`) the Signal K server parses the query string before the plugin sees it. `from` and `to` arrive as `Temporal.Instant` values parsed from ISO 8601 timestamps. `duration` arrives as a `Temporal.Duration`: the server parses an ISO 8601 duration string first, and if that fails and the text is a non-negative decimal integer (`/^\d+$/`), the server builds a duration of that many seconds. The server rejects with HTTP 400 any request that has none of `from` and `duration`, that has all three of `from`, `to` and `duration`, or that has `from` not strictly before `to`. Those rejections never reach the plugin. The server's messages are `Either from or duration parameter is required at minimum`, `Cannot specify all of from, to, and duration together; choose either from+to or from+duration or to+duration`, `from parameter must be before to parameter` and `duration parameter must be an ISO 8601 duration string (e.g. 'PT15M') or an integer number of seconds`; they are not the plugin's behaviour.
2. A caller that obtains the provider directly through the server's programmatic History API can pass `duration` as a JavaScript number of seconds instead of a `Temporal.Duration`, and can pass combinations the REST route rejects. The rules below cover both entry points.

#### Resolution rules

3. Sample the current instant once at the start of resolution. Every rule below that says `now` uses that one sample.
4. Convert a numeric `duration` to a `Temporal.Duration` of that many whole seconds. A non-integer number (for example `1.5`) and `NaN` each raise the `RangeError` the Temporal implementation in use produces for that input (Error strings). A `Temporal.Duration` input passes through unchanged.
5. Apply the first matching rule in this order. A parameter counts as present when it is truthy: an absent property, `undefined`, and the number `0` all count as absent. A `Temporal.Duration` object always counts as present, including a zero-length one such as `PT0S`.

| Order | Present parameters                                                              | Resolved `from`                                                                    | Resolved `to`       |
| ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| 1     | `from` and `to` (`duration` ignored if also present)                            | `from`                                                                             | `to`                |
| 2     | `from` and `duration`                                                           | `from`                                                                             | `from` + `duration` |
| 3     | `to` and `duration`                                                             | `to` - `duration`                                                                  | `to`                |
| 4     | `from` only                                                                     | `from`                                                                             | `now`               |
| 5     | `duration` only                                                                 | `now` - `duration`                                                                 | `now`               |
| 6     | none of the above (nothing, or `to` alone, or `to` with a numeric `0` duration) | throw `Error` with message `Invalid time range: provide at least from or duration` |                     |

6. Duration arithmetic is exact instant arithmetic. Fractional ISO components resolve exactly: `PT1.5S` added to `2024-01-01T00:00:00Z` gives `2024-01-01T00:00:01.5Z`; `PT0.5H` gives `2024-01-01T00:30:00Z`; `PT36H` gives `2024-01-02T12:00:00Z`.
7. A duration that carries a calendar component (`years`, `months`, `weeks` or `days`; for example `P1D`, `P1W`, `P1DT1H`) cannot be added to or subtracted from an instant. Resolution raises the `RangeError` the Temporal implementation in use produces for that operation (Error strings); the message names the offending component. Only durations expressed purely in hours, minutes, seconds and sub-second units resolve. `PT24H` is the way to ask for one day.
8. A negative duration is accepted and applied with its sign. With `from` and `-PT1H` the resolved `to` lies one hour before `from`. With `-PT1H` alone the resolved `from` lies one hour after `now`. No check rejects a resolved range whose `from` is after its `to`.
9. A zero-length `Temporal.Duration` resolves to a range whose `from` equals its `to`: with `from` and `PT0S` both bounds equal `from`; with `PT0S` alone both bounds equal `now`.

#### Output format

10. Both resolved strings are the `Temporal.Instant` canonical ISO 8601 form in UTC with a `Z` suffix. The time part always carries seconds. Fractional seconds appear only when non-zero, with trailing zeros removed, up to nine digits: `2024-01-01T00:00:00Z`, `2024-01-01T00:00:00.123Z`, `2024-01-01T00:00:00.123456Z`, `2024-01-01T00:00:00.123456789Z`.
11. An input instant given with a non-zero UTC offset is emitted in UTC: `2024-01-01T02:00:00+02:00` becomes `2024-01-01T00:00:00Z`.
12. A `now`-derived bound carries nine fractional digits, for example `2026-09-03T10:26:57.385217364Z`.

#### Errors and use of the resolved range

13. When resolution raises, the request rejects with that error and no database query runs. Over REST the Signal K server answers the client with HTTP 400 and body `{ "error": "<message>" }` where `<message>` is the error message verbatim, for example `{ "error": "Invalid time range: provide at least from or duration" }`.
14. In `getValues`, the `range` field of the response carries the resolved strings unchanged (full precision, no re-serialisation).
15. In every WHERE clause the boundaries are re-parsed as dates and re-serialised as `YYYY-MM-DDTHH:mm:ss.sssZ`. Sub-millisecond digits are dropped (floor to the millisecond), so the predicate `ts >= '<from>' AND ts <= '<to>'` always has exactly three fractional digits and each of its bounds can lie up to one millisecond before the corresponding `range` string.
16. A boundary that does not parse as a date rejects the request with `Invalid timestamp: <value>`. In `getPaths` and `getContexts` this happens immediately after resolution. In `getValues` it happens at the first path specification, after the context and that specification's path and sourceRef have been validated (Behaviour 4 and 5), and never when the request carries no path specifications (Behaviour 5 rule 8).

### 3. Sample bucket guard (`getValues`)

The guard runs after time range resolution and before context validation and before any SQL is issued.

1. A path specification is _sampled_ when its `path` is `navigation.position`, or when its `aggregate` is not one of `sma`, `ema`, `middle_index`.
2. A path specification is _fallback-capable_ when its `path` is not `navigation.position` and its `aggregate` is not one of `sma`, `ema`, `middle_index`.
3. Let `sampledCount` be the count of sampled specifications and `fallbackCount` the count of fallback-capable ones.
4. The guard applies only when `sampledCount > 0` and `resolution` is a number greater than `0`.
5. `rangeSeconds` is the difference in seconds between the two resolved boundaries parsed as dates (`to` minus `from`).
6. `effective = max(1, floor(resolution))`.
7. `perSeries = ceil(rangeSeconds / effective)`.
8. `buckets = perSeries * (sampledCount + fallbackCount)`. Each fallback-capable specification is budgeted twice because a non-numeric path costs a sampled numeric query and then a sampled string query, and which paths are non-numeric is unknown before querying.
9. When `buckets > 1000000` the request rejects with the guard error string. `<buckets>` is the value computed in rule 8; `<sampled>` is the count from rule 3, not the doubled query count; `<resolution>` is the requested `resolution` as given (so a request with `resolution: 0.5` reports `resolution 0.5s`).
10. A range whose `to` precedes `from` gives a negative bucket count and never trips the guard.
11. A resolved boundary that cannot be parsed as a date never trips the guard, whatever the resolution and range. The request then fails with `Invalid timestamp: <value>` per Behaviour 2 rule 16, after context validation.
12. A request with no path specifications has `sampledCount = 0`, so the guard is skipped whatever the resolution and range.

### 4. Context handling (`getValues`)

1. When the request has no `context` field (`undefined` or `null`), the requested context is `vessels.self`.
2. The stored form of the requested context is `self` when the requested context equals `self`, `vessels.self`, or the server's self context string. Every other value is used unchanged as the stored form.
3. The stored form must match the safe identifier pattern; otherwise the request rejects with `Invalid identifier: <stored form>`. An empty-string `context` is not treated as absent: its stored form is the empty string, which fails the pattern and rejects with `Invalid identifier: ` (nothing after the colon and space).
4. Every per-path WHERE clause in the request carries `context = '<stored form>'`.
5. The response `context` field echoes the requested context from rule 1 verbatim: a request with `self` answers `self`, a request with the full self URN answers that URN, and a request without a context answers `vessels.self`.

### 5. Per-specification processing (`getValues`)

1. Specifications are processed one at a time, in request order. Each specification's SQL completes before the next specification is validated or queried. The first error rejects the whole request; no partial response is produced.
2. For each specification, the `path` must match the safe identifier pattern; otherwise the request rejects with `Invalid identifier: <path>`. Because of rule 1, an invalid path in the second specification is detected only after the first specification's query has run.
3. The response `values` entry for the specification is `{ path, method }` with `method` equal to the requested `aggregate` string, plus `sourceRef` when the specification's `sourceRef` is a non-empty string. An empty-string `sourceRef` behaves as absent everywhere.
4. When `sourceRef` is non-empty it must match the safe identifier pattern; otherwise the request rejects with `Invalid identifier: <sourceRef>`. The `<src>` clause ` AND source = '<sourceRef>'` is appended to the WHERE clause of every query issued for that specification, including the string fallback query and the position queries.
5. A request may carry the same `path` more than once. Each specification produces its own column, positioned by specification index, so the same path with two sourceRefs yields two distinct columns with independent rows.
6. Which query family is used depends on the specification, in this order of precedence: position path (Behaviour 6), client-side aggregate (Behaviour 7), numeric aggregate with string fallback (Behaviour 8).
7. A specification is _downsampled_ when the request `resolution` is a number greater than `0`. The `SAMPLE BY` period is `<R> = max(1, floor(resolution))` seconds, so `0.5` and `1.9` both become `SAMPLE BY 1s` and `2600` becomes `SAMPLE BY 2600s`. `resolution` absent, `0`, negative or `NaN` means raw rows.
8. A request whose `pathSpecs` array is empty issues no SQL and resolves with `values: []` and `data: []`, with `context` and `range` filled per Behaviour 4 and Behaviour 2. The time range is still resolved and the context is still validated, so an unresolvable range or an invalid context rejects such a request; the resolved boundaries are not validated as dates.

### 6. Position path

1. A specification whose `path` is exactly `navigation.position` reads `signalk_position`. The WHERE clause is W1 followed by `<src>`; no `path =` clause is present.
2. The per-axis aggregate `<POS>` is `last` when the requested `aggregate` is `last`, and `first` for every other value, including `average`, `min`, `max`, `mid`, `middle_index`, `sma`, `ema` and unknown names.
3. Downsampled: Q6. Raw: Q7 (oldest 10000 rows).
4. Each returned row becomes `[ts, { latitude: <lat>, longitude: <lon> }]` when both `lat` and `lon` are non-null, and `[ts, null]` when either is null (which is every `FILL(NULL)` bucket).
5. The position path never falls back to the string table, ignores the `sma`/`ema`/`middle_index` computations, and counts as one sampled query in the bucket guard.
6. The `values` entry keeps the requested `aggregate` as `method` even when `first` was substituted.

### 7. Client-side aggregates (`sma`, `ema`, `middle_index`) on non-position paths

1. The provider issues Q3 (`LIMIT 50000`, oldest rows first) regardless of `resolution`; `resolution` neither buckets nor limits these columns. These specifications are never counted by the bucket guard.
2. Rows come back as `[ts, value]` pairs with `value` a number or `null`. The computed series has one entry per row, at the row's timestamp.
3. The whole of `parameter[0]` is converted to a number; a string that is not entirely a numeric literal yields `NaN`:
   - `undefined` (no `parameter` array, or an empty one) converts to `NaN`.
   - `""` converts to `0`.
   - Leading and trailing whitespace is ignored: `" 3 "` converts to `3`.
   - Exponent, hexadecimal, octal and binary literals convert: `"1e1"` is `10`, `"0x10"` is `16`, `"1e-1"` is `0.1`.
   - `".5"` is `0.5`; `"5."` is `5`; `"Infinity"` is `Infinity`.
   - Any trailing or embedded non-numeric text yields `NaN`: `"2x"`, `"0.9x"`, `"abc"`.
   - A leading sign converts (`"-1"` is `-1`); the server strips `-`, `+` and spaces from the `paths` query parameter before building specifications, so over REST `ema:-0.5` arrives as `0.5`.
4. `sma` window: the converted number when it is an integer `>= 1`; otherwise `5`. So `"0"`, `"-1"`, `"abc"`, `"2x"`, `"2.7"`, `""`, `"Infinity"` and an absent parameter all give `5`; `"1"`, `"2"`, `"10"` and `"1e1"` are honoured.
5. `sma` computation, over rows in timestamp order, with a window that starts empty:
   1. A `null` value emits `null` and leaves the window unchanged.
   2. A non-null value is appended to the window; when the window then holds more than `n` values the oldest is dropped; the emitted value is the arithmetic mean of the window.
   3. The first `n - 1` non-null samples therefore emit partial means, not `null`.
6. `ema` alpha: the converted number when `0 < alpha <= 1`; otherwise `0.2`. So `"0"`, `"2"`, `"abc"`, `"0.9x"`, `""`, `"Infinity"` and an absent parameter all give `0.2`; `"0.9"`, `"1"`, `".5"` and `"1e-1"` are honoured.
7. `ema` computation, over rows in timestamp order, with no previous value at the start:
   1. A `null` value emits the previous smoothed value, which is `null` when no non-null sample has been seen yet.
   2. The first non-null value becomes the smoothed value and is emitted as is.
   3. Each later non-null value `v` sets the smoothed value to `alpha * v + (1 - alpha) * previous` and emits it.
8. `middle_index`: with `k` rows read, the value at index `floor(k / 2)` is kept (it may itself be `null`) and every other index emits `null`. Zero rows read gives an empty column. The `parameter` array is ignored. The index is taken over the whole raw read, not per bucket.
9. Client-side specifications never fall back to the string table. A path whose rows are only in `signalk_str` yields an empty column without error.
10. The `values` entry keeps the requested `aggregate` as `method`.

### 8. Numeric aggregates with string fallback

1. Downsampled: Q1 with `<AGG>` from the aggregate table. Raw: Q2 (oldest 10000 rows, the aggregate plays no part).
2. Rows come back as `[ts, value]`; `value` is `null` in every fabricated `FILL(NULL)` bucket.
3. The numeric result is _empty_ when no returned row has a non-null value. Zero rows is empty; a row set made only of `FILL(NULL)` buckets is also empty. A result with at least one non-null value is used as the column and the string table is not queried.
4. When the numeric result is empty the provider issues the string query with the same WHERE clause (W2 with `<src>`): Q4 when downsampled, Q5 when raw. Only one string query is attempted; an error from it (for example a QuestDB `Invalid column: value_kind` failure on a table without that column) rejects the request unchanged, with no retry and no untyped answer.
5. When downsampled, the `values` entry's `method` is overwritten with `last` before the string query runs, because `last()` is the aggregate actually applied. When raw, `method` keeps the requested `aggregate`.
6. Each string row `[ts, value_str, value_kind]` becomes `[ts, value]` where `value` is:
   - the boolean `value_str === "true"` when `value_kind` is exactly `boolean` (so a tagged `true` becomes `true`, and a tagged `false`, or any other text, becomes `false`);
   - `value_str` unchanged (a string, or `null` in a `FILL(NULL)` bucket) when `value_kind` is anything else, including `null`. An untagged text `true` stays the string `true`.
7. The string column is used even when it is empty; there is no further fallback.

### 9. Assembling `data`

1. The set of timestamps is the union of the timestamps of every column. Timestamps are the strings QuestDB returns for `ts` (for example `2024-01-01T00:00:01.000000Z`) and are sorted as strings, ascending; with QuestDB's fixed-width format this is chronological order.
2. Each output row is `[ts, v0, v1, ...]` with one slot per path specification in request order. A slot holds that column's value at that timestamp, or `null` when the column has no row at that timestamp or its value is `null` or `undefined`. `false` and `0` are kept as they are.
3. When a column contains two rows with the same timestamp, the later row in query order wins for that slot.
4. Raw reads that hit their `LIMIT` return the oldest rows in the range only. Nothing in the response indicates truncation.

### 10. `getPaths`

1. Resolves the time range (Behaviour 2), builds W0 (no context clause; every context contributes) and issues Q8.
2. Returns the first column of each returned row, in the order QuestDB returns them (`ORDER BY path`). `navigation.position` appears whenever `signalk_position` has at least one row in the range.

### 11. `getContexts`

1. Resolves the time range, builds W0 and issues Q9.
2. Returns the first column of each returned row, in QuestDB's `ORDER BY context` order, with the stored value `self` replaced by `vessels.self`. Only the exact string `self` is translated. Because ordering happens on the stored strings, `vessels.self` occupies the position `self` sorted into, which is before every `vessels.urn:...` entry.

### 12. README invariant

1. The README section `## Reading the history`, subsection `### v2`, contains the exact phrase `default window of 5 or alpha of 0.2`, where `5` is the `sma` window default and `0.2` is the `ema` alpha default from Client-side aggregate parameters. The phrase changes only when those defaults change.

## Cross-surface references

- Table names `signalk`, `signalk_str`, `signalk_position` and the columns listed under Tables and columns read: defined by the storage surface, read here.
- Stored own-vessel context `self`; every other context stored as the Signal K context string: shared with the ingestion and history v1 surfaces.
- The server's self context string identifies the own vessel; the same string is used by the ingestion surface to decide what is the own vessel.
- `value_kind` marker `boolean` and the `true`/`false` text encoding in `value_str`: written by the ingestion surface, decoded here and by the history v1 surface.
- `navigation.position` is the only path stored in `signalk_position`, which has no `path` column: storage and ingestion surfaces.
- Safe identifier pattern `^[a-zA-Z0-9_.:-]+$` and the error strings `Invalid identifier: <value>` and `Invalid timestamp: <value>`: shared with the storage surface, which also serves the history v1 surface.
- Time range resolution (Behaviour 2) is used only by this surface. The history v1 surface takes `startTime` directly and never sees `from`, `to` or `duration`.
- The SQL predicate boundary format `YYYY-MM-DDTHH:mm:ss.sssZ` (floor to the millisecond) is the storage surface's timestamp validation; the history v1 surface applies the same re-serialisation to `startTime`.
- Timestamps are ISO 8601 UTC strings throughout; no epoch numbers cross this boundary.
- Query execution: a SQL string in; out, the rows of the QuestDB `/exec` response `dataset`, each row a positional array of column values; errors propagate unchanged. Timeouts and connection failures belong to the storage surface.
- QuestDB `ts` strings come back in the form `2024-01-01T00:00:01.000000Z`.
- Registration timing (after tables exist) belongs to the plugin lifecycle surface.

## Disagreements with the README

- The README says the v2 surface "Supports all aggregate methods" and lists eight; it omits `middle_index`, which the provider accepts and computes client-side (Behaviour 7.8).

## Observed defects

- A `navigation.position` column requested with `average`, `min`, `max`, `mid`, `middle_index`, `sma` or `ema` reports that name in `values[].method` although `first` was applied; the string fallback rewrites `method` to `last` in the equivalent case.
- An unknown `aggregate` name runs `avg(value)` and is reported under the unknown name.
- A path stored only in `signalk_str` requested with `sma`, `ema` or `middle_index` returns an empty column with no error, because those specifications never fall back to the string table.
- `middle_index` yields one non-null value across the whole raw read (the oldest 50000 rows at most) instead of one per bucket, and ignores `resolution`.
- An empty-string `context` rejects with `Invalid identifier: ` instead of being treated as absent.
- Raw reads silently truncate to the oldest 10000 rows (50000 for client-side aggregates) with nothing in the response to say so.
- The guard error text reports `across <sampled> paths` while `<buckets>` was computed over `sampledCount + fallbackCount` queries, so for one numeric path the message reports twice the buckets a reader would compute from "1 paths".
- A numeric `duration` of `0` is treated as absent: `{ from, duration: 0 }` resolves `to` as `now` instead of `from`, and `{ duration: 0 }` alone rejects with `Invalid time range: provide at least from or duration`. The same zero as an ISO string or a `Temporal.Duration` (`PT0S`) resolves to an empty range at `from` or `now`. The REST route always hands the plugin a `Temporal.Duration`, so REST clients see the `PT0S` behaviour for `duration=0`; only programmatic callers see the numeric-zero behaviour.
- `duration=P1D` (or any duration with a `days`, `weeks`, `months` or `years` component) is a valid ISO 8601 duration the server accepts, yet the request fails with HTTP 400 and the message `Duration field day not supported by Temporal.Instant. Try Temporal.ZonedDateTime instead.`
- A negative duration (`duration=-PT1H`) passes the server's parser and this surface, producing a range with `from` after `to`. The query then matches no rows and the response `range` echoes the inverted bounds with no error.
- Sub-millisecond digits in `from` or `to` appear in the response `range` but not in the SQL predicate, so each queried bound can lie up to one millisecond before the reported one.

## Test cases

Unless stated otherwise: the server self context is `vessels.urn:mrn:imo:mmsi:123456789`; the range is `from` `2024-01-01T00:00:00Z` to `2024-01-01T01:00:00Z`; the database returns no rows; the path is `navigation.speedOverGround` with `aggregate` `average` and `parameter` `[]`.

### Time range resolution

Rows here use one default path specification. `from` and `to` in the outcome are the response `range` fields; `Temporal.Duration` inputs are written as ISO 8601 duration text.

| Input / state                                                                       | Action      | Expected outcome                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `from` = `2024-01-01T00:00:00Z`, `to` = `2024-01-02T00:00:00Z`                      | `getValues` | `from` = `2024-01-01T00:00:00Z`; `to` = `2024-01-02T00:00:00Z`                                                                                                                                                                 |
| `from` = `2024-01-01T00:00:00Z`, `duration` = `PT1H`                                | `getValues` | `from` = `2024-01-01T00:00:00Z`; `to` = `2024-01-01T01:00:00Z`                                                                                                                                                                 |
| `to` = `2024-01-02T00:00:00Z`, `duration` = `PT1H`                                  | `getValues` | `from` = `2024-01-01T23:00:00Z`; `to` = `2024-01-02T00:00:00Z`                                                                                                                                                                 |
| `from` = `2024-01-01T00:00:00Z`, no `to`, no `duration`                             | `getValues` | `from` = `2024-01-01T00:00:00Z`; `to` parses as an instant within 5 seconds before the wall clock at check time                                                                                                                |
| `duration` = `PT30M`, no `from`, no `to`                                            | `getValues` | `to` minus `from` is 30 minutes within a 5 second tolerance; `to` is within 5 seconds before the wall clock                                                                                                                    |
| `from` = `2024-01-01T00:00:00Z`, `duration` = number `3600`                         | `getValues` | `to` = `2024-01-01T01:00:00Z`                                                                                                                                                                                                  |
| No `from`, `to` or `duration`                                                       | `getValues` | Rejects with `Error` message `Invalid time range: provide at least from or duration`; no SQL issued                                                                                                                            |
| `to` = `2024-01-02T00:00:00Z` only                                                  | `getValues` | Rejects with `Error` message `Invalid time range: provide at least from or duration`; no SQL issued                                                                                                                            |
| `from` = `2024-01-01T00:00:00Z`, `to` = `2024-01-02T00:00:00Z`, `duration` = `PT1H` | `getValues` | `from` = `2024-01-01T00:00:00Z`, `to` = `2024-01-02T00:00:00Z`; duration ignored                                                                                                                                               |
| `from` = `2024-01-01T02:00:00+02:00`, `to` = `2024-01-02T00:00:00Z`                 | `getValues` | `from` = `2024-01-01T00:00:00Z`                                                                                                                                                                                                |
| `from` = `2024-01-01T00:00:00Z`, `duration` = `PT1.5S`                              | `getValues` | `to` = `2024-01-01T00:00:01.5Z`; the SQL predicate contains `ts <= '2024-01-01T00:00:01.500Z'`                                                                                                                                 |
| `from` = `2024-01-01T00:00:00.123456789Z`, `to` = `2024-01-02T00:00:00Z`            | `getValues` | `from` = `2024-01-01T00:00:00.123456789Z`; the SQL predicate contains `ts >= '2024-01-01T00:00:00.123Z'`                                                                                                                       |
| `from` = `2024-01-01T00:00:00Z`, `duration` = `PT0S`                                | `getValues` | `from` = `to` = `2024-01-01T00:00:00Z`                                                                                                                                                                                         |
| `from` = `2024-01-01T00:00:00Z`, `duration` = number `0`                            | `getValues` | `from` = `2024-01-01T00:00:00Z`; `to` = `now` (current behaviour, listed under Observed defects)                                                                                                                               |
| `duration` = number `0` only                                                        | `getValues` | Rejects with `Error` message `Invalid time range: provide at least from or duration` (current behaviour, listed under Observed defects)                                                                                        |
| `from` = `2024-01-01T00:00:00Z`, `duration` = `P1D`                                 | `getValues` | Rejects with the `RangeError` the Temporal implementation in use raises for a calendar-unit duration (current text `Duration field day not supported by Temporal.Instant. Try Temporal.ZonedDateTime instead.`); no SQL issued |
| `from` = `2024-01-01T00:00:00Z`, `duration` = `-PT1H`                               | `getValues` | `from` = `2024-01-01T00:00:00Z`, `to` = `2023-12-31T23:00:00Z`; no error; every SQL predicate contains `ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2023-12-31T23:00:00.000Z'`                                                 |
| `from` = `2024-01-01T00:00:00Z`, `duration` = number `1.5`                          | `getValues` | Rejects with the `RangeError` the Temporal implementation in use raises for a fractional number of seconds (current text `unsupported fractional value 1.5`); no SQL issued                                                    |
| `from` = `2024-01-01T00:00:00Z`, `duration` = number `NaN`                          | `getValues` | Rejects with the `RangeError` the Temporal implementation in use raises for `NaN` (current text `not a number`); no SQL issued                                                                                                 |
| Default range, `pathSpecs: []`                                                      | `getValues` | Resolves with `context` `vessels.self`, `range` with the default bounds, `values: []`, `data: []`; no SQL issued                                                                                                               |
| Default range, `pathSpecs: []`, `context: ""`                                       | `getValues` | Rejects with `Invalid identifier: `; no SQL issued                                                                                                                                                                             |
| `from` and `to` whose text is not a date, `resolution: 1`, one default spec         | `getValues` | Rejects with `Invalid timestamp: <from text>`; the message does not contain `sample buckets`; no SQL issued                                                                                                                    |
| `from` and `to` whose text is not a date                                            | `getPaths`  | Rejects with `Invalid timestamp: <from text>`; no SQL issued                                                                                                                                                                   |

### Context handling

| Input / state                                   | Action      | Expected outcome                                                            |
| ----------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `context: "vessels.self"`                       | `getValues` | First SQL contains `context = 'self'`                                       |
| `context` equal to the server self context      | `getValues` | First SQL contains `context = 'self'`                                       |
| `context: "self"`                               | `getValues` | First SQL contains `context = 'self'`                                       |
| `context: "vessels.urn:mrn:imo:mmsi:987654321"` | `getValues` | First SQL contains `context = 'vessels.urn:mrn:imo:mmsi:987654321'`         |
| No `context` field                              | `getValues` | Response `context` is `vessels.self`; first SQL contains `context = 'self'` |

### Position path

| Input / state                                                            | Action      | Expected outcome                           |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------ |
| `path: "navigation.position"`, `aggregate: "first"`, `resolution: 60`    | `getValues` | SQL contains `first(lat)` and `first(lon)` |
| Same, `aggregate: "last"`                                                | `getValues` | SQL contains `last(lat)` and `last(lon)`   |
| Same, `aggregate` each of `average`, `min`, `max`, `mid`, `middle_index` | `getValues` | SQL contains `first(lat)` and `first(lon)` |

### Sample bucket guard

| Input / state                                                                                                                      | Action      | Expected outcome                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Range 2024-01-01 to 2024-03-01, `resolution: 1`, one `navigation.position` spec with `first`                                       | `getValues` | Rejects with an error whose message contains `sample buckets`; no SQL issued                               |
| Same range, `resolution: 2600`                                                                                                     | `getValues` | Exactly one SQL issued, containing `SAMPLE BY 2600s`                                                       |
| One-hour range, `resolution: 0.5`, numeric path, database empty                                                                    | `getValues` | A `signalk_str` query is issued; every SQL issued contains `SAMPLE BY 1s` and none contains `SAMPLE BY 0s` |
| Range 2024-01-01 to 2024-01-08, `resolution: 1`, specs `navigation.position`/`first` and `navigation.speedOverGround`/`average`    | `getValues` | Rejects with message containing `sample buckets`; no SQL issued                                            |
| Same range and resolution, one spec `electrical.switches.bilgePump.state`/`first`                                                  | `getValues` | Rejects with message containing `sample buckets`; no SQL issued                                            |
| Same range and resolution, one spec `navigation.position`/`first`                                                                  | `getValues` | Accepted; at least one SQL issued                                                                          |
| Range 2024-01-01 to 2024-03-01, `resolution: 1`, spec with `aggregate` `sma` (`["5"]`), `ema` (`["0.2"]`) or `middle_index` (`[]`) | `getValues` | Exactly one SQL issued; it contains `LIMIT 50000` and does not contain `SAMPLE BY`                         |

### String-table fallback

Path specifications here use `context: "self"` and `aggregate: "first"` unless stated.

| Input / state                                                                                                                                                                  | Action      | Expected outcome                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `signalk` returns nothing; `signalk_str` returns `["2024-01-01T00:00:01.000000Z", "true"]`; path `watermaker.brineomatic.high_pressure_pump_on`                                | `getValues` | `data` is `[["2024-01-01T00:00:01.000000Z", "true"]]`; a `signalk_str` query was issued                                  |
| Every query returns `["2024-01-01T00:00:01.000000Z", 4.2]`; path `environment.depth.belowKeel`                                                                                 | `getValues` | `data` is `[["2024-01-01T00:00:01.000000Z", 4.2]]`; no `signalk_str` query issued                                        |
| `resolution: 600`; `signalk` returns two rows with `null` values; `signalk_str` returns `["2024-01-01T00:00:00.000000Z", "false"]`; path `electrical.switches.bilgePump.state` | `getValues` | `data` is `[["2024-01-01T00:00:00.000000Z", "false"]]`                                                                   |
| `resolution: 600`, `aggregate: "average"`; `signalk` empty; `signalk_str` returns `[ts, "on"]`; path `navigation.state`                                                        | `getValues` | `values[0].method` is `last`                                                                                             |
| No `resolution`, `aggregate: "first"`; same rows; path `navigation.state`                                                                                                      | `getValues` | `values[0].method` is `first`                                                                                            |
| `signalk` empty; `signalk_str` returns `[ts, "true", "boolean"]`; path `electrical.switches.bilgePump.state`                                                                   | `getValues` | `data[0][1]` is the boolean `true`                                                                                       |
| `signalk` empty; `signalk_str` returns `[ts, "true", null]`; path `navigation.state`                                                                                           | `getValues` | `data[0][1]` is the string `true`                                                                                        |
| Any query mentioning `value_kind` fails with `QuestDB query failed (400): Invalid column: value_kind`; path `some.path`                                                        | `getValues` | Rejects with an error whose message contains `Invalid column: value_kind`; exactly one `signalk_str` query was attempted |
| `resolution: 600`; `signalk` empty; `signalk_str` returns `[ts, "on"]`; path `navigation.state`                                                                                | `getValues` | The `signalk_str` SQL contains `last(value_str)` and does not contain `avg(`                                             |

### Path and context discovery

| Input / state                  | Action        | Expected outcome                                                       |
| ------------------------------ | ------------- | ---------------------------------------------------------------------- |
| Range given by `from` and `to` | `getPaths`    | The single SQL contains `signalk_position` and `'navigation.position'` |
| Range given by `from` and `to` | `getContexts` | The single SQL contains `signalk_position`                             |

### sourceRef filtering

Path specifications here use `context: "self"`.

| Input / state                                                                                                                                 | Action      | Expected outcome                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `sourceRef: "n2k-on-ve.can0.115"`; queries return `[ts, 4.2]`                                                                                 | `getValues` | First SQL contains `AND source = 'n2k-on-ve.can0.115'`                             |
| No `sourceRef`; queries return `[ts, 4.2]`                                                                                                    | `getValues` | First SQL does not contain `source =`                                              |
| `path: "navigation.position"`, `aggregate: "first"`, `sourceRef: "gps.main"`; queries return `[ts, 60.1, 24.9]`                               | `getValues` | First SQL contains `signalk_position` and `AND source = 'gps.main'`                |
| `path: "switches.bilge.state"`, `aggregate: "first"`, `sourceRef: "n2k-on-ve.can0.42"`; `signalk` empty; `signalk_str` returns `[ts, "true"]` | `getValues` | A `signalk_str` query is issued and it contains `AND source = 'n2k-on-ve.can0.42'` |
| Two specs for the same path: first with `sourceRef: "gps.main"`, second without; queries return `[ts, 4.2]`                                   | `getValues` | `values[0].sourceRef` is `gps.main`; `values[1]` has no `sourceRef` key            |
| Two specs for the same path: `sourceRef: "gps.main"` (rows `[ts, 1.1]`) and `sourceRef: "gps.backup"` (rows `[ts, 2.2]`), same `ts`           | `getValues` | `data` is `[[ts, 1.1, 2.2]]`                                                       |
| `sourceRef: "x'; DROP TABLE signalk"`                                                                                                         | `getValues` | Rejects                                                                            |

### Aggregate names

| Input / state                                                                                                 | Action      | Expected outcome                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| One numeric path, `aggregate` `constructor` (a name every object inherits), `resolution` 60, one row returned | `getValues` | SQL contains `avg(value)` and no function text; the unlisted name is treated as unknown |
| One numeric path, `aggregate` `bogus`, `resolution` 60, one row returned                                      | `getValues` | SQL contains `avg(value)`; `values[0].method` is `bogus`                                |

### Client-side aggregate parameters

The raw read returns six rows one second apart (`2024-01-01T00:00:01.000000Z` to `...:06...`) with values `[0, 10, 20, 30, 40, 50]`; `context: "self"`. "Column" means the second element of each `data` row, in order.

| Input / state                                                                                                   | Action      | Expected outcome                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `aggregate: "sma"`, `parameter` each of `["0"]`, `["-1"]`, `["abc"]`, `["2x"]`, `["2.7"]`, `[""]`, `[]`, absent | `getValues` | Column is `[0, 5, 10, 15, 20, 30]`                                                     |
| `aggregate: "sma"`, `parameter: ["2"]`                                                                          | `getValues` | Column is `[0, 5, 15, 25, 35, 45]`                                                     |
| `aggregate: "sma"`, `parameter: ["1"]`                                                                          | `getValues` | Column is `[0, 10, 20, 30, 40, 50]`                                                    |
| `aggregate: "ema"`, `parameter` each of `["abc"]`, `["0"]`, `["2"]`, `["0.9x"]`, `[""]`, `[]`, absent           | `getValues` | Every column value is a finite number; column is `[0, 2, 5.6, 10.48, 16.384, 23.1072]` |
| `aggregate: "ema"`, `parameter: ["0.9"]`                                                                        | `getValues` | Column is `[0, 9, 18.9, 28.89, 38.888999999999996, 48.8889]`                           |
| `aggregate: "ema"`, `parameter: ["1"]`                                                                          | `getValues` | Column is `[0, 10, 20, 30, 40, 50]`                                                    |
| Raw read returns values `[0, 10, null, 30]`; `aggregate: "sma"`, `parameter: ["2"]`                             | `getValues` | Column is `[0, 5, null, 20]`                                                           |
| Raw read returns values `[0, 10, null, 30]`; `aggregate: "ema"`, `parameter: ["0.2"]`                           | `getValues` | Column is `[0, 2, 2, 7.6]`                                                             |

### README invariant

| Input / state                                        | Action                                                                                                                                                             | Expected outcome      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| README `## Reading the history`, subsection `### v2` | Search for the phrase `default window of <sma window default> or alpha of <ema alpha default>` with the defaults from Client-side aggregate parameters substituted | The phrase is present |
