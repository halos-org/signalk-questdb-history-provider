# v1 history provider (WebSocket playback)

## Purpose

The plugin registers one v1 history provider with the Signal K server through `app.registerHistoryProvider()`. The server calls it for three things: to ask whether any recorded data exists from a given start time, to replay recorded deltas over a WebSocket at a playback rate, and to build a snapshot of the last known value of every path at a given moment. The provider reads the three tables the plugin records into (`signalk`, `signalk_str`, `signalk_position`), reads them in one interleaved pass ordered by timestamp, decodes each stored row back into the value the live delta carried, groups rows into deltas that carry the recorded source as `$source`, and maps the stored own-vessel context back to the server's self context. It issues SQL over QuestDB's HTTP query endpoint and never writes.

## Interface constants

### Registration and server-facing API

| Item                          | Value                                                                                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration call             | `app.registerHistoryProvider(provider)`                                                                                                                                                                                                      |
| Provider object               | `{ hasAnyData, streamHistory, getHistory }`                                                                                                                                                                                                  |
| `hasAnyData` signature        | `hasAnyData(options, callback)` where `options` is `{ startTime: Date, playbackRate: number, subscribe?: string }` and `callback` is `(hasResults: boolean) => void`                                                                         |
| `streamHistory` signature     | `streamHistory(socket, options, onChange)` returning a stop function `() => void`; `socket` has `write(data: unknown): void` and `on(event: string, cb: (...args: unknown[]) => void): void`; `options` as above; `onChange` is `() => void` |
| `getHistory` signature        | `getHistory(date: Date, path: string, callback)` where `callback` receives an array of delta objects in the replayed-delta wire shape                                                                                                        |
| Own-vessel context as stored  | `self`                                                                                                                                                                                                                                       |
| Own-vessel context as emitted | the value of `app.selfContext` (for example `vessels.urn:mrn:imo:mmsi:123456789`)                                                                                                                                                            |
| Debug output channel          | `app.debug(message)`                                                                                                                                                                                                                         |

### Timing and limits

| Item                                                    | Value                      |
| ------------------------------------------------------- | -------------------------- |
| Playback window length                                  | 60 seconds                 |
| Rows per window read (page limit)                       | 10000                      |
| Delay after an empty window                             | 100 ms                     |
| Delay after a full page (resume within the same window) | 0 ms                       |
| Delay after a non-full page                             | `60000 / playbackRate` ms  |
| Delay after a query error                               | 1000 ms                    |
| Minimum effective playback rate                         | 1                          |
| Timestamp literal format in SQL                         | `YYYY-MM-DDTHH:mm:ss.sssZ` |

### Row shape shared by every value query

Every value query projects the same six columns in this order, with these aliases:

| Column      | Meaning                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`        | row timestamp, as QuestDB returns it (microsecond precision, for example `2024-01-01T00:00:00.000000Z`)                                                    |
| `path`      | Signal K path; the position table has no path column, so the literal `'navigation.position'` is projected                                                  |
| `context`   | stored context (`self` for the own vessel)                                                                                                                 |
| `source`    | `CAST(source AS STRING) source` in every branch                                                                                                            |
| `valuetext` | the stored value as text                                                                                                                                   |
| `kind`      | the decoding tag: `'number'` literal for the numeric table, `CAST(value_kind AS STRING)` for the string table, `'position'` literal for the position table |

### SQL shapes (verbatim)

`hasAnyData` count, with `<start>` the start time literal:

```
SELECT sum(c) as cnt FROM (SELECT count() c FROM signalk WHERE ts >= '<start>' UNION ALL SELECT count() c FROM signalk_str WHERE ts >= '<start>' UNION ALL SELECT count() c FROM signalk_position WHERE ts >= '<start>')
```

The three value branches, with `<where>` a predicate and `<tail>` an optional clause appended inside the branch:

```
SELECT ts, path, context, CAST(source AS STRING) source, CAST(value AS STRING) valuetext, 'number' kind FROM signalk WHERE <where><tail>
```

```
SELECT ts, path, context, CAST(source AS STRING) source, value_str valuetext, CAST(value_kind AS STRING) kind FROM signalk_str WHERE <where><tail>
```

```
SELECT ts, 'navigation.position' path, context, CAST(source AS STRING) source, concat(CAST(lat AS STRING), ',', CAST(lon AS STRING)) valuetext, 'position' kind FROM signalk_position WHERE <where><tail>
```

Playback window read, with `<where>` = `ts >= '<from>' AND ts < '<to>'` and no `<tail>`; the branches are not parenthesised and the trailing clause applies to the whole union:

```
<numeric branch> UNION ALL <string branch> UNION ALL <position branch> ORDER BY ts LIMIT 10000
```

Last-known-name lookup, with `<start>` the playback start time literal:

```
SELECT context, value_str FROM signalk_str WHERE path = 'name' AND value_kind = 'identity' AND ts <= '<start>' LATEST ON ts PARTITION BY context
```

Snapshot (`getHistory`), with `<where>` = `ts <= '<at>'`; each branch is parenthesised and carries its own `LATEST ON` as `<tail>`:

```
(<numeric branch with tail  LATEST ON ts PARTITION BY path, context>) UNION ALL (<string branch with tail  LATEST ON ts PARTITION BY path, context>) UNION ALL (<position branch with tail  LATEST ON ts PARTITION BY context>)
```

### Wire shapes

Replayed delta:

```
{ context: <context>, updates: [ { timestamp: <ts>, $source?: <source>, values: [ { path: <path>, value: <value> }, ... ] } ] }
```

Injected vessel-name delta:

```
{ context: <context>, updates: [ { timestamp: <ts>, values: [ { path: "", value: { name: <name> } } ] } ] }
```

Vessel-name value item inside a replayed delta (from a stored identity row):

```
{ path: "", value: { name: <name> } }
```

### Status strings

| String                                    | Where                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `streamHistory error: <message>`          | debug output on a failed window read or name lookup during playback                                                    |
| `getHistory error: <message>`             | debug output on a failed snapshot query                                                                                |
| `Invalid timestamp: <value>`              | thrown when a timestamp literal cannot be parsed                                                                       |
| `QuestDB query failed (<status>): <body>` | the error message a failed HTTP query carries (produced by the storage surface; it is what `<message>` above contains) |

## Behaviour

### Common: timestamps and stored contexts

1. Every timestamp the server passes is a `Date`. The provider formats it as `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, millisecond precision) and uses the result as the SQL literal. An invalid `Date` makes the provider call throw a `RangeError` synchronously, before any query is issued and before any callback is invoked.
2. A row whose `context` is null or the empty string is treated as `self`.
3. A row whose `source` is a string carries it; any other value (null, absent) means no source.
4. The `ts` column value is used verbatim as the delta `timestamp`. It is not reformatted, so it keeps QuestDB's microsecond precision.

### Value decoding

Each row decodes to one delta value from its `valuetext` and `kind`:

1. `valuetext` null or undefined: the value is `null`, whatever the `kind`.
2. `kind` = `number`: the text is converted to a number with JavaScript's standard string-to-number conversion: surrounding whitespace is ignored, the remaining text must be a complete numeric literal (decimal with optional sign, fraction and exponent, or a `0x`, `0o`, `0b` literal, or `Infinity`), an empty or whitespace-only text gives `0`, and any other text gives NaN. If the result is not finite (NaN, Infinity, -Infinity), the value is `null`.
3. `kind` = `boolean`: the value is `true` exactly when the text is the four characters `true` (case-sensitive, no surrounding whitespace); every other text gives `false`.
4. `kind` = `position`: split the text on `,`; the first part is latitude, the second longitude, each converted with the same string-to-number conversion as `number`. If both are finite the value is `{ latitude, longitude }`; otherwise `null`. A text with no `,` has no second part and gives `null`. Parts beyond the second are ignored.
5. `kind` = `identity`: the value is `valuetext` unchanged (a string); the grouping rule below reshapes it.
6. Any other `kind` (including `string`, null, and unknown tags): the value is `valuetext` unchanged. A text row whose content is the word `true` without a `boolean` tag stays the string `"true"`. A null tag replays as a string.

### Grouping rows into deltas

1. Rows group by the triple (`ts` text, context, source). Rows with no source form their own group per (`ts`, context), separate from every sourced group.
2. Each group becomes one delta with exactly one update. The update carries `timestamp` = the `ts` text, `values` = the group's rows in input order, and `$source` = the source only when the group has one. A group without a source has no `$source` key at all.
3. Deltas are emitted in order of first appearance of their `ts` among the input rows; within one `ts`, groups are emitted in order of first appearance.
4. A row with `path` = `name`, `kind` = `identity`, and a string value becomes the value item `{ path: "", value: { name: <value> } }`. A row with `path` = `name` and any other kind stays `{ path: "name", value: <value> }`.
5. The delta `context` at this stage is the stored context (`self` for the own vessel). Only playback resolves it (see below); the snapshot does not.

### `hasAnyData`

1. Issue the count query above with `<start>` = `options.startTime` as an ISO literal. `playbackRate` and `subscribe` are not used.
2. Read the first column of the first row as a number. Call `callback(true)` when it is greater than 0. Call `callback(false)` when it is 0 or the result has no rows.
3. On any query error call `callback(false)`. No debug message is written.
4. The count spans all three tables, so a recording that holds only string or boolean values, or only positions, answers `true`.

### `streamHistory`

Setup:

1. Start time = `options.startTime` as an ISO literal. Effective playback rate = `max(1, options.playbackRate)`.
2. `onChange` is accepted and never called or used. `options.subscribe` is ignored.
3. The stop function is registered on the socket with `socket.on("end", stop)` and is also returned to the caller.
4. The first window read starts immediately (the query is issued during the call; the call returns without waiting for it).
5. The playback cursor starts at the start time.

Each window read:

1. `<from>` = cursor as ISO literal; `<to>` = cursor + 60 s as ISO literal. Issue the playback window read query above.
2. If the result has no rows: set the cursor to `<to>` and schedule the next read after 100 ms. Nothing is written to the socket. This repeats without limit, including for windows after the newest recorded row and for windows in the future, until the stream is stopped.
3. Otherwise group the rows into deltas.
4. Before the first delta of the whole stream is written, and only once per stream, issue the last-known-name lookup bound at the playback start time. The result gives each stored context (null or empty becomes `self`) its last-known name, the row's `value_str`; an empty string counts as no name. If the lookup fails, no context has a name, no debug message is written, and playback continues unlabeled. If the stream was stopped while the lookup was in flight, nothing more is written or scheduled.
5. For each delta in order:
   1. If the stream has ended, stop writing; nothing more is scheduled.
   2. Resolve the context: a stored context of `self` becomes `app.selfContext`; any other context is unchanged.
   3. If the lookup gave the stored context a name, and no name delta has been written for that stored context yet in this stream, write the injected vessel-name delta first, with the resolved context and the delta's own `timestamp`. It has no `$source`. Each stored context receives at most one injected name delta per stream.
   4. Write the delta with the resolved context; everything else is unchanged.
6. Full page (row count >= 10000): the window may hold more rows than one read returned, so the stream resumes inside the same window rather than skipping to `<to>`:
   1. The resume point is the last returned row's `ts` parsed as a JS `Date`, that is truncated to milliseconds.
   2. If the resume point is later than the cursor, the cursor moves to it. Rows at that millisecond that were already sent are sent again on the next read; rows at that millisecond that did not fit in the page are not lost.
   3. If the resume point equals the cursor (every row of the page shares the cursor's millisecond), the cursor moves forward by 1 ms so the read cannot repeat forever. Rows in that millisecond beyond the 10000 returned are skipped.
   4. The cursor never moves past `<to>`: it is `min(resume point, <to>)`.
   5. Schedule the next read after 0 ms.
7. Non-full page: set the cursor to `<to>` and schedule the next read after `60000 / playbackRate` ms. At rate 1 that is 60 s of wall time per 60 s of history.
8. Any error in the read, the grouping, or the name lookup (the lookup itself never throws; a failing lookup yields an empty map) writes `streamHistory error: <message>` to debug output and schedules the same window again after 1000 ms with the cursor unchanged. A permanent failure (for example a table missing an expected column) therefore repeats the query and the debug line once per second for as long as the stream runs.
9. An exception thrown by a socket write is handled the same way as a read error: `streamHistory error: <message>` goes to debug output and the same window is read again after 1000 ms with the cursor unchanged. The deltas written to the socket before the throwing write are then written again. An injected name delta is never written a second time, and the name lookup is not repeated.

Timers and stopping:

1. At most one read is pending at any time. A pending read alone never keeps the Node process alive.
2. The stop function ends the stream and cancels the pending read if one is scheduled. Calling it more than once is harmless.
3. After stop: no further read is scheduled, a read already in flight writes nothing once it completes, and no further deltas are written.
4. The server's socket `end` event calls the same stop function.
5. The stream has no natural end. It runs until stopped.

### `getHistory` (snapshot)

1. `<at>` = `date` as an ISO literal. The `path` argument is accepted and not used: the query is never filtered by it, and every path in every context is returned. (The server passes the request URL segments in this argument and walks into the tree it builds from the returned deltas, so filtering would starve the snapshot.)
2. Issue the snapshot query above. `LATEST ON` is applied inside each branch, per table, and the three results are unioned; it is not applied over the union. The numeric and string branches partition by `path, context`; the position branch partitions by `context` only.
3. Because the partitions do not include `source`, the snapshot carries at most one row per (path, context) for values and one row per context for position: the latest row, whichever source wrote it.
4. Group the rows into deltas (grouping rules above) and call `callback(deltas)`. The deltas carry the stored context; `self` is not mapped to `app.selfContext` here.
5. On any error write `getHistory error: <message>` to debug output and call `callback([])`. Exactly one query attempt is made; there is no retry.

### Loud failure on a missing column

1. Every value query names `ts`, `path`, `context`, `source`, and the per-table value columns (`value`; `value_str`, `value_kind`; `lat`, `lon`). A table that lacks one of these is not a table this plugin created, and the query fails with QuestDB's message naming the column (for example `QuestDB query failed (400): Invalid column: value_kind` or `Invalid column: source`).
2. The provider never falls back to a narrower query. The snapshot reports the failure once through debug output and returns an empty delta list; playback reports it on every 1-second retry.
3. Unrelated query failures (for example a 500 with any other message) follow the same path: the message is passed through to debug output unchanged and the same empty result or retry applies.

## Cross-surface references

- Table names `signalk`, `signalk_str`, `signalk_position` and the columns `ts`, `path`, `context`, `source`, `value`, `value_str`, `value_kind`, `lat`, `lon` are created by the storage surface and written by the ILP wire format surface; this surface reads them and fails loudly if one is absent.
- The own vessel is stored under context `self`; this surface maps `self` to `app.selfContext` on playback only.
- `value_kind` tags written by the ingestion surface are `boolean`, `identity`, or null (plain string); this surface decodes exactly those, and treats an unknown tag as a plain string.
- Vessel names are stored in `signalk_str` under path `name` with `value_kind` = `identity`; this surface replays them as empty-path `{ name }` object values and injects the last-known name per context at playback start.
- The position table has no path column; this surface always projects `navigation.position` for it.
- `ts` is the server receive time at microsecond precision; this surface replays it verbatim as the delta `timestamp` and truncates it to milliseconds only for cursor arithmetic.
- Timestamp literals in SQL use the format `YYYY-MM-DDTHH:mm:ss.sssZ`; the parsing error string `Invalid timestamp: <value>` and the HTTP error string `QuestDB query failed (<status>): <body>` come from the storage surface.
- Debug output goes to `app.debug`.

## Disagreements with the README

None. The README states that v1 playback runs at configurable speed multipliers using chunked reads, that replayed updates carry the recorded sourceRef as `$source` with one update per source, and that rows recorded with a null `source` replay unattributed; the code does all three.

## Observed defects

- Snapshot deltas from `getHistory` carry the literal context `self` for the own vessel, while playback deltas carry `app.selfContext`; the same recorded row is reported under two different contexts depending on the API used.
- After the cursor passes the newest recorded row, playback issues an empty-window query every 100 ms indefinitely, including for windows in the future, until the socket ends.
- A permanent query failure during playback (schema mismatch, unreachable database) retries and logs once per second for as long as the socket stays open; nothing ends the stream or informs the client.
- A non-numeric `playbackRate` (NaN) is not clamped: the computed delay is NaN, which Node treats as 1 ms, so playback runs with no pacing.
- When a page of 10000 rows all share the cursor's millisecond, the rows in that millisecond beyond the page are skipped silently.
- Position rows with more than two comma-separated parts decode from the first two parts without error.
- A socket write that throws mid-window is retried as a window read: after 1000 ms every delta of that window written before the throwing write is written to the socket a second time.

## Test cases

### `hasAnyData`

| Input / state                                 | Action                                                 | Expected outcome                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Count query answers a single row with value 7 | `hasAnyData` with start `2024-01-01T00:00:00Z`, rate 1 | Callback receives `true`; the one query issued contains `FROM signalk `, `FROM signalk_str `, and `FROM signalk_position ` |
| Count query answers a single row with value 0 | `hasAnyData` with the same options                     | Callback receives `false`                                                                                                  |

### Value decoding through the snapshot

| Input / state                                                                                              | Action                                 | Expected outcome                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| Row `navigation.speedOverGround`, text `4.2`, kind `number`                                                | `getHistory` at `2024-01-01T01:00:00Z` | Value is the number `4.2` (type `number`, not a string)                               |
| Row `navigation.state`, text `anchored`, kind `string`                                                     | `getHistory`                           | Value is the string `anchored`                                                        |
| Row `electrical.switches.bilgePump.state`, text `true`, kind `boolean`                                     | `getHistory`                           | Value is boolean `true`                                                               |
| Row `some.text.path`, text `true`, kind null                                                               | `getHistory`                           | Value is the string `"true"`                                                          |
| Row `x.off`, text `false`, kind `boolean`                                                                  | `getHistory`                           | Value is boolean `false`                                                              |
| Row `navigation.position`, text `-17.77,177.38`, kind `position`                                           | `getHistory`                           | Value is `{ latitude: -17.77, longitude: 177.38 }`                                    |
| Row path `name`, context `vessels.urn:mrn:imo:mmsi:244813000`, text `Sea Breeze`, kind `identity`          | `getHistory`                           | The delta carries `{ path: "", value: { name: "Sea Breeze" } }`                       |
| Row path `name`, context `self`, text `not an identity`, kind `string`                                     | `getHistory`                           | The delta carries `{ path: "name", value: "not an identity" }` and no empty-path item |
| Row `x.broken`, text `not-a-number`, kind `number`; row `navigation.position`, text `bad`, kind `position` | `getHistory`                           | Both values are `null`; no NaN is emitted                                             |

### Missing columns and query failures

| Input / state                                                                   | Action                                 | Expected outcome                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Every query fails with `QuestDB query failed (400): Invalid column: value_kind` | `getHistory` at `2024-01-01T01:00:00Z` | Callback receives `[]`; exactly one query was attempted; a debug message contains `Invalid column: value_kind` |
| Every query fails with `QuestDB query failed (500): something else`             | `getHistory`                           | Callback receives `[]`; a debug message contains `something else`                                              |
| Every query fails with `Invalid column: source`                                 | `getHistory`                           | Callback receives `[]`; exactly one query was attempted; a debug message contains `Invalid column: source`     |

### Snapshot query shape

| Input / state         | Action                                                | Expected outcome                                                                                                                      |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Query answers no rows | `getHistory` at `2024-01-01T00:00:00Z` with path `""` | The SQL contains `LATEST ON` exactly three times; contains `FROM signalk_position` and `PARTITION BY context)`; contains `value_kind` |

### Source attribution

| Input / state                                                                                                                                                                                                           | Action       | Expected outcome                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three rows at one timestamp, context `self`: `navigation.position` from `gps.main` (`60.1,24.9`), `navigation.position` from `gps.backup` (`60.2,24.8`), `environment.depth.belowKeel` with null source (`3.2`, number) | `getHistory` | Three deltas; the `gps.main` update holds only `{ latitude: 60.1, longitude: 24.9 }`; the `gps.backup` update holds only `{ latitude: 60.2, longitude: 24.8 }`; the depth update holds `3.2` and has no `$source` key at all |

### Playback window reads (start `2024-01-01T00:00:00Z`)

| Input / state                                                                                                                    | Action                                                       | Expected outcome                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| First read returns 10000 rows; rows 1 to 9999 at `00:00:00.000000Z`, row 10000 at `00:00:30.000000Z`; later reads return no rows | `streamHistory` at rate 1, wait for the second read, stop    | The second read's SQL contains `2024-01-01T00:00:30.000` (resumes at the last row, not at the window end)     |
| First read returns 10000 rows; row 1 at `00:00:05.000000Z`, rows 2 to 10000 at `00:00:10.000000Z`                                | `streamHistory` at rate 1, wait for the second read, stop    | The second read's SQL contains `2024-01-01T00:00:10.000` (re-reads the tied millisecond)                      |
| First read returns 10000 rows, all at `00:00:00.000000Z`                                                                         | `streamHistory` at rate 1, wait for the second read, stop    | The second read's SQL contains `2024-01-01T00:00:00.001` (steps forward by 1 ms)                              |
| First read returns one row at `00:00:05.000000Z`; later reads return no rows                                                     | `streamHistory` at rate 6000, wait for the second read, stop | The second read's SQL contains `2024-01-01T00:01:00.000` (next 60 s window), and it arrives after about 10 ms |

### Vessel-name injection (start `2024-01-01T00:00:00Z`, rate 1, server self context `vessels.urn:mrn:imo:mmsi:123456789`)

| Input / state                                                                                                                                         | Action                                         | Expected outcome                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First window holds two `navigation.speedOverGround` rows for `vessels.urn:mrn:imo:mmsi:244813000`; name lookup answers that context with `Sea Breeze` | `streamHistory`, wait for three written deltas | The first written delta has context `vessels.urn:mrn:imo:mmsi:244813000` and values `[{ path: "", value: { name: "Sea Breeze" } }]`; exactly one written delta contains an empty-path value; exactly one name lookup was issued, containing `ts <= '2024-01-01T00:00:00` and `value_kind = 'identity'` |
| First window holds one row for context `self`; name lookup answers `self` with `Vessel Aurora`                                                        | `streamHistory`, wait for two written deltas   | The first written delta has context `vessels.urn:mrn:imo:mmsi:123456789` and first value `{ path: "", value: { name: "Vessel Aurora" } }`                                                                                                                                                              |
| First window holds one row for `vessels.urn:mrn:imo:mmsi:244813000`; the name lookup throws `QuestDB query failed (500): boom`                        | `streamHistory`, wait for one written delta    | The written delta has context `vessels.urn:mrn:imo:mmsi:244813000`; no written delta contains an empty-path value                                                                                                                                                                                      |

### Process lifetime

| Input / state                                                                                                     | Action               | Expected outcome                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| A fresh Node process starts a playback (one data row in every window, no names) and never calls the stop function | Wait for the process | The process exits on its own with code 0 in well under 10 s (an armed 60 s pacing timer must not keep it alive) |
