# Storage: QuestDB tables, schema repair, retention and SQL transport

## Purpose

The plugin records into three QuestDB tables that it creates and owns, and it touches nothing else in the database. On every start it creates the tables if they do not exist, repairs a table that QuestDB's ILP ingestion auto-created with the wrong designated timestamp, and applies the configured retention as a table TTL. It repeats the repair check on a fixed heartbeat while it runs. All SQL, DDL included, travels over QuestDB's HTTP endpoint with a deadline enforced on both ends of the connection. This file also states the identifier and timestamp validation that every value spliced into SQL passes.

## Interface constants

### Endpoint defaults

| Constant                  | Value                  | Notes                                                                                   |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| Default QuestDB HTTP port | `9000`                 | Used for every SQL statement and the health probe                                       |
| Default QuestDB ILP port  | `9009`                 | Not used by this surface; listed because the same host/port pair is configured together |
| Base URL                  | `http://<host>:<port>` | Plain HTTP; no TLS, no authentication                                                   |

### HTTP transport

| Constant                   | Value                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------- |
| SQL endpoint (JSON result) | `GET /exec`                                                                           |
| Query parameter            | `query` (URL-encoded by standard search-parameter serialisation; a space becomes `+`) |
| Request header             | `Statement-Timeout: <deadline in milliseconds>`                                       |
| Statement deadline         | `30000` ms                                                                            |
| Health probe request       | `GET /exec?query=SELECT+1` (literal URL; no `Statement-Timeout` header)               |
| Health probe deadline      | `5000` ms                                                                             |
| Non-OK error               | `QuestDB query failed (<HTTP status>): <response body>`                               |

### Owned tables

| Table              | Columns (in order)                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signalk`          | `ts TIMESTAMP`, `path SYMBOL CAPACITY 512 CACHE`, `context SYMBOL CAPACITY 128 CACHE`, `source SYMBOL CAPACITY 256 CACHE`, `value DOUBLE`                                            |
| `signalk_str`      | `ts TIMESTAMP`, `path SYMBOL CAPACITY 256 CACHE`, `context SYMBOL CAPACITY 128 CACHE`, `source SYMBOL CAPACITY 256 CACHE`, `value_str VARCHAR`, `value_kind SYMBOL CAPACITY 8 CACHE` |
| `signalk_position` | `ts TIMESTAMP`, `context SYMBOL CAPACITY 128 CACHE`, `source SYMBOL CAPACITY 256 CACHE`, `lat DOUBLE`, `lon DOUBLE`                                                                  |

Common properties of all three: designated timestamp `ts`, `PARTITION BY DAY`, `WAL`, deduplication enabled. Dedup upsert keys: `(ts, path, context, source)` for `signalk` and `signalk_str`; `(ts, context, source)` for `signalk_position`.

The fixed order of the three tables, used by every loop over them, is `signalk`, `signalk_str`, `signalk_position`.

### DDL statements (verbatim)

Each statement is sent as one string with the text shown below. Surrounding whitespace and line breaks are not significant: QuestDB ignores them, and an implementation may lay the statement out differently.

Statement 1:

```sql
CREATE TABLE IF NOT EXISTS signalk (
  ts        TIMESTAMP,
  path      SYMBOL CAPACITY 512 CACHE,
  context   SYMBOL CAPACITY 128 CACHE,
  source    SYMBOL CAPACITY 256 CACHE,
  value     DOUBLE
) TIMESTAMP(ts)
  PARTITION BY DAY
  WAL
  DEDUP UPSERT KEYS(ts, path, context, source)
```

Statement 2:

```sql
CREATE TABLE IF NOT EXISTS signalk_str (
  ts         TIMESTAMP,
  path       SYMBOL CAPACITY 256 CACHE,
  context    SYMBOL CAPACITY 128 CACHE,
  source     SYMBOL CAPACITY 256 CACHE,
  value_str  VARCHAR,
  value_kind SYMBOL CAPACITY 8 CACHE
) TIMESTAMP(ts)
  PARTITION BY DAY
  WAL
  DEDUP UPSERT KEYS(ts, path, context, source)
```

Statement 3:

```sql
CREATE TABLE IF NOT EXISTS signalk_position (
  ts        TIMESTAMP,
  context   SYMBOL CAPACITY 128 CACHE,
  source    SYMBOL CAPACITY 256 CACHE,
  lat       DOUBLE,
  lon       DOUBLE
) TIMESTAMP(ts)
  PARTITION BY DAY
  WAL
  DEDUP UPSERT KEYS(ts, context, source)
```

### Retention

| Constant                             | Value                                                    |
| ------------------------------------ | -------------------------------------------------------- |
| Config key                           | `retentionDays`                                          |
| Config title                         | `Retention (days, 0 = keep forever)`                     |
| Config default                       | `0`                                                      |
| TTL statement, positive whole days N | `ALTER TABLE <table> SET TTL N DAYS`                     |
| TTL statement, keep forever          | `ALTER TABLE <table> SET TTL 0h`                         |
| Failure log line (error level)       | `Could not apply the retention setting: <error message>` |

### Schema repair

| Constant                       | Value                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| Introspection query            | `SELECT "column" FROM table_columns('<table>') WHERE designated = true` |
| Expected designated timestamp  | `ts`                                                                    |
| Drop statement                 | `DROP TABLE IF EXISTS <table>`                                          |
| Heartbeat interval             | `60000` ms                                                              |
| Rebuild log line (debug level) | `Rebuilt <table>: ILP had auto-created it with a wrong schema`          |
| Failure log line (debug level) | `schema heal check failed: <error message>`                             |

### Validation

| Constant                | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| Identifier pattern      | `/^[a-zA-Z0-9_.:-]+$/`                                                 |
| Identifier error        | `Invalid identifier: <value>`                                          |
| Timestamp error         | `Invalid timestamp: <value>`                                           |
| Timestamp output format | ISO 8601 with millisecond precision in UTC, `YYYY-MM-DDTHH:mm:ss.sssZ` |

### Plugin status lines touched by this surface

| Text                                      | Kind   |
| ----------------------------------------- | ------ |
| `Waiting for QuestDB to become ready...`  | status |
| `QuestDB not responding at <host>:<port>` | error  |
| `Creating tables...`                      | status |
| `Startup failed: <error message>`         | error  |

## Behaviour

### SQL transport

1. Every SQL statement, DDL included, is sent as `GET <base URL>/exec?query=<statement>`. The response is parsed as JSON and returned unchanged. The JSON shape is `{ "columns": [{ "name": string, "type": string }, ...], "dataset": [[cell, ...], ...], "count": number, "timestamp": number }`.
2. The request does not set QuestDB's `nm` parameter, so the response always carries `columns` metadata.
3. Every `/exec` request carries a deadline of `30000` ms. Every statement this plugin sends, from any surface, uses that one deadline.
4. The deadline is enforced on both sides. The HTTP request is aborted client-side when the deadline passes. The same number is sent as the request header `Statement-Timeout` so QuestDB stops executing the statement at the same moment. The header value is the decimal deadline in milliseconds, without a unit.
5. When the client-side abort fires, the statement fails with the runtime's abort error. The plugin does not translate it.
6. When the response status is not 2xx, the statement fails with `QuestDB query failed (<status>): <body>`. `<body>` is the response body as text; if the body cannot be read it is the empty string.
7. When the response status is 2xx and the body is not valid JSON, the statement fails with the runtime's JSON parse error. The plugin does not translate it.
8. The health probe sends `GET <base URL>/exec?query=SELECT+1` with a `5000` ms client-side abort and no `Statement-Timeout` header. The result is true when the response status is 2xx and false otherwise. A network error, an abort, or any other thrown error yields false; the probe never throws.

### Validation

9. An identifier (a table name, a Signal K path, a context, or any other value spliced into SQL as an identifier or a single-quoted literal) is accepted when the whole string matches `/^[a-zA-Z0-9_.:-]+$/`. An empty string does not match. Any other string is rejected by throwing `Invalid identifier: <value>`. Accepted examples: `navigation.speedOverGround`, `self`, `vessels.urn:mrn:imo:mmsi:123456789`, `electrical.batteries.house_bank.voltage`. Rejected examples: `'; DROP TABLE signalk;--`, `path OR 1=1`, a value containing a line break.
10. A timestamp string is accepted when the JavaScript `Date` parser produces a valid instant from it, and is returned normalised to `YYYY-MM-DDTHH:mm:ss.sssZ` in UTC. `2024-06-15T12:00:00.000Z` returns unchanged. `2024-06-15` returns `2024-06-15T00:00:00.000Z`. `2024-06-15T14:00:00+02:00` returns `2024-06-15T12:00:00.000Z`. Any other string, the empty string included, is rejected by throwing `Invalid timestamp: <value>`. The parser is lax: a bare digit string such as `123` is accepted as a year and returns an instant in year 122 or 123 depending on the host time zone.

### Start-up sequence

11. On start the plugin sets the status `Waiting for QuestDB to become ready...` and polls the health probe every `500` ms until one succeeds or `30000` ms have passed. It then sends one more probe in every case, also after a successful poll. When that final probe fails it sets the error `QuestDB not responding at <host>:<port>` and stops the start-up. `<host>:<port>` is the HTTP host and port.
12. When QuestDB answers, the plugin sets the status `Creating tables...` and sends the three DDL statements in order (`signalk`, `signalk_str`, `signalk_position`) with the `30000` ms deadline each. Each statement is `CREATE TABLE IF NOT EXISTS`, so an existing table is left as it is. No `ALTER TABLE` is issued during creation; the tables are created in their final shape and nothing migrates an older shape.
13. If any DDL statement fails, the start-up fails and the plugin sets the error `Startup failed: <error message>`, where `<error message>` is the transport error from rule 5, 6 or 7. Nothing later in this sequence runs.
14. After the DDL, one schema-repair pass (rules 19 to 26) runs before the ILP write connection is opened, unless a stop landed during table creation (lifecycle surface). This pass is best-effort: its failure does not fail the start-up.
15. After the ILP connection is up and the history providers and delta subscription are registered, the plugin applies retention (rules 16 to 18). Then it starts the repair heartbeat (rule 27) and sets the recording status.

### Retention

16. Retention is a property of the tables, not a job the plugin runs: the plugin sets a TTL on each owned table and QuestDB drops whole expired partitions itself. The plugin never deletes rows or partitions.
17. The configured `retentionDays` (missing key treated as `0`) is normalised to a whole number of days: floor the value, then clamp to a minimum of `0`. The TTL text is `N DAYS` when the normalised value is greater than `0`, and `0h` otherwise. Examples: `30` gives `30 DAYS`; `7.9` gives `7 DAYS`; `0` gives `0h`; `-1` gives `0h`.
18. The plugin then sends `ALTER TABLE <table> SET TTL <ttl>` for each owned table in the fixed order, one statement at a time, with the `30000` ms deadline, on every start. Zero is a statement, not a skip: `SET TTL 0h` removes an expiry a table carried from an earlier setting. A changed setting takes effect at the next plugin start (or restart triggered by saving the configuration). If any statement fails, the plugin logs `Could not apply the retention setting: <error message>` at error level, the remaining statements in that loop are not sent, and start-up continues; recording is not affected. A later repair (rule 24) uses the value normalised in this pass even when one of its statements failed.

### Schema repair

19. Purpose: QuestDB's ILP ingestion auto-creates a missing table and names its designated timestamp `timestamp`, while the owned schema and every query use `ts`. If an owned table is dropped while the plugin writes, the next ILP flush recreates it in that wrong shape: rows ingest, but every query filtering on `ts` fails and history reads nothing. The repair detects that shape and rebuilds the table.
20. For each owned table in the fixed order the plugin sends the introspection query `SELECT "column" FROM table_columns('<table>') WHERE designated = true`. The column reference `"column"` is double-quoted because `column` is a keyword in QuestDB.
21. The designated timestamp is the first cell of the first result row. A result with no rows means the table is missing or has no designated timestamp.
22. A mismatch exists when a designated timestamp is present and is not `ts`. A missing table is not a mismatch (the DDL creates it correctly). A table with no designated timestamp is not a mismatch. An error from the introspection query (table does not exist, introspection unavailable, transport failure) is swallowed and counts as no mismatch.
23. A table that exists with `ts` as designated timestamp but with other columns missing or of another type is not detected and not repaired.
24. When a mismatch exists the plugin repairs it with these statements in this order, each with the `30000` ms deadline: `DROP TABLE IF EXISTS <table>` for the mismatched table only; then all three DDL statements from rule 12; then `ALTER TABLE <table> SET TTL <ttl>` for all three owned tables, where `<ttl>` is the text derived (rule 17) at the most recent retention application in the current start, or `0h` when no retention application has begun in the current start. The rows ILP wrote into the wrong-shape table are lost; they were unreadable through the plugin anyway.
25. A repair that rebuilt a table logs `Rebuilt <table>: ILP had auto-created it with a wrong schema` at debug level. A correct table produces no DDL: only the introspection query runs.
26. One repair pass covers the owned tables in the fixed order, sequentially. If a step inside the pass throws (a failed DROP, CREATE or TTL statement), the pass stops at that table, logs `schema heal check failed: <error message>` at debug level, and the remaining tables are not checked until the next pass. The pass never throws to its caller.
27. The heartbeat runs a repair pass every `60000` ms, starting after retention was applied at start-up. Passes do not overlap: when a pass is still running at the next tick, that tick is skipped. The heartbeat is cancelled on stop, and no repair pass runs after stop.

## Cross-surface references

- Table names `signalk`, `signalk_str`, `signalk_position` and their column names and types are the schema the ingestion surface and both history surfaces depend on.
- `ts` is the designated timestamp of every owned table, holds server receive time, and is the column every range filter uses.
- `source` is the delta sourceRef and is part of every dedup key; two rows with equal `ts`, `path`, `context` and differing `source` are both kept.
- `value_kind` in `signalk_str` is how readers distinguish a stored boolean from the string `true`.
- The identifier pattern `/^[a-zA-Z0-9_.:-]+$/` and error `Invalid identifier: <value>` apply to every path, context and table name the history providers splice into SQL.
- The timestamp validator returns `YYYY-MM-DDTHH:mm:ss.sssZ` and throws `Invalid timestamp: <value>`; the history providers use it for range bounds.
- The `/exec` deadline of `30000` ms applies to every provider query.
- Result JSON shape `{ columns, dataset, count, timestamp }` is what the history providers consume.
- Config key `retentionDays`, title `Retention (days, 0 = keep forever)`, default `0`.
- Default ports `9000` (HTTP) and `9009` (ILP).
- Status strings `Waiting for QuestDB to become ready...`, `Creating tables...`, `QuestDB not responding at <host>:<port>`, `Startup failed: <message>` are set by the lifecycle surface; `Recording to QuestDB at <host>:<port>` follows retention application.

## Disagreements with the README

- The README says a table-creation failure "reports itself". The observable text is `Startup failed: <error message>`, where the message is `QuestDB query failed (<status>): <body>` or the runtime's network or abort error; no table name appears unless QuestDB's body carries it.
- The README describes retention only as "Table TTL; QuestDB expires whole partitions (0 = keep forever)". The code also floors fractional values and treats negative values as `0`, and sends `SET TTL 0h` explicitly for `0` rather than skipping.
- The README does not mention the schema repair (rules 19 to 27) at all; it is undocumented behaviour that drops and recreates an owned table.

## Observed defects

- A repair pass stops at the first table whose repair step throws, so a later table with a mismatch is not checked until the next heartbeat tick; the only symptom is a debug line `schema heal check failed: ...`.
- The start-up repair pass runs before retention is applied on that start, so a table rebuilt during start-up first receives `SET TTL 0h` on all three tables and then, moments later, the configured TTL; the transient is harmless but doubles the ALTER traffic.
- The timestamp validator accepts a bare digit string such as `123` and returns an instant in year 122 or 123 instead of rejecting it.
- The health probe omits the `Statement-Timeout` header, so a probe that is aborted client-side after `5000` ms leaves QuestDB to finish `SELECT 1` on its own.

## Test cases

### Identifier validation

| Input / state                             | Action              | Expected outcome                     |
| ----------------------------------------- | ------------------- | ------------------------------------ |
| `navigation.speedOverGround`              | Validate identifier | Returns `navigation.speedOverGround` |
| `self`                                    | Validate identifier | Returns `self`                       |
| `vessels.urn:mrn:imo:mmsi:123456789`      | Validate identifier | Returns the same string              |
| `electrical.batteries.house_bank.voltage` | Validate identifier | Returns the same string              |
| `tanks.fuel.starboard_main.currentLevel`  | Validate identifier | Returns the same string              |
| `'; DROP TABLE signalk;--`                | Validate identifier | Throws                               |
| `path OR 1=1`                             | Validate identifier | Throws                               |
| `path` + line break + `SELECT`            | Validate identifier | Throws                               |

### Timestamp validation

| Input / state              | Action             | Expected outcome                            |
| -------------------------- | ------------------ | ------------------------------------------- |
| `2024-06-15T12:00:00.000Z` | Validate timestamp | Returns `2024-06-15T12:00:00.000Z`          |
| `2024-06-15`               | Validate timestamp | Returns a string starting with `2024-06-15` |
| `not-a-date`               | Validate timestamp | Throws                                      |
| empty string               | Validate timestamp | Throws                                      |

### Table creation

| Input / state                                        | Action        | Expected outcome                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QuestDB answers every statement with an empty result | Create tables | Three statements sent; one contains `CREATE TABLE IF NOT EXISTS signalk (` and `DEDUP UPSERT KEYS(ts, path, context, source)`, one contains `CREATE TABLE IF NOT EXISTS signalk_str (` and `DEDUP UPSERT KEYS(ts, path, context, source)`, one contains `CREATE TABLE IF NOT EXISTS signalk_position (` and `DEDUP UPSERT KEYS(ts, context, source)` |
| Same                                                 | Create tables | The `signalk_str` statement contains the column `value_kind`                                                                                                                                                                                                                                                                                         |
| Same                                                 | Create tables | No statement sent contains `ALTER TABLE`                                                                                                                                                                                                                                                                                                             |

### Retention

| Input / state           | Action          | Expected outcome                                                                                                                                    |
| ----------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention setting `30`  | Apply retention | Exactly, in order: `ALTER TABLE signalk SET TTL 30 DAYS`, `ALTER TABLE signalk_str SET TTL 30 DAYS`, `ALTER TABLE signalk_position SET TTL 30 DAYS` |
| Retention setting `0`   | Apply retention | Exactly, in order: `ALTER TABLE signalk SET TTL 0h`, `ALTER TABLE signalk_str SET TTL 0h`, `ALTER TABLE signalk_position SET TTL 0h`                |
| Retention setting `7.9` | Apply retention | Every statement sent ends with `SET TTL 7 DAYS`                                                                                                     |
| Retention setting `-1`  | Apply retention | Every statement sent ends with `SET TTL 0h`                                                                                                         |

### Schema introspection and repair

Each row describes one repair pass over the owned tables. "Introspection answers `X`" means the introspection query for that table returns one row whose cell is `X`.

| Input / state                                                                                                                                                                      | Action      | Expected outcome                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any                                                                                                                                                                                | Repair pass | Every introspection query sent is `SELECT "column" FROM table_columns('<table>') WHERE designated = true` with the table name in single quotes; no statement sent contains an unquoted `SELECT column`                                                                                                                                                                                |
| Introspection answers `ts` for every table                                                                                                                                         | Repair pass | Three introspection queries sent, for `signalk`, `signalk_str`, `signalk_position` in that order; no statement sent contains `DROP TABLE` or `CREATE TABLE`; no `Rebuilt` log line                                                                                                                                                                                                    |
| Introspection returns no rows for every table                                                                                                                                      | Repair pass | Same as the previous row: only the three introspection queries are sent; no rebuild                                                                                                                                                                                                                                                                                                   |
| Introspection for `signalk` fails with `table does not exist`; the other tables answer `ts`                                                                                        | Repair pass | No statement sent contains `DROP TABLE` or `CREATE TABLE`; the pass continues to `signalk_str` and `signalk_position`; no log line                                                                                                                                                                                                                                                    |
| Introspection for `signalk` answers `timestamp` the first time and `ts` afterwards; the other tables answer `ts`; every other statement returns an empty result                    | Repair pass | Statements sent after the first introspection, in order: `DROP TABLE IF EXISTS signalk`; the three DDL statements; `ALTER TABLE signalk SET TTL 0h`, `ALTER TABLE signalk_str SET TTL 0h`, `ALTER TABLE signalk_position SET TTL 0h`; then the introspection queries for the remaining tables. Log line `Rebuilt signalk: ILP had auto-created it with a wrong schema` at debug level |
| Retention setting `30` applied earlier in this start; introspection for `signalk` answers `timestamp`; the other tables answer `ts`; every other statement returns an empty result | Repair pass | The TTL statements sent are exactly, in order, `ALTER TABLE signalk SET TTL 30 DAYS`, `ALTER TABLE signalk_str SET TTL 30 DAYS`, `ALTER TABLE signalk_position SET TTL 30 DAYS`; `ALTER TABLE signalk SET TTL 30 DAYS` is sent after the statement containing `CREATE TABLE IF NOT EXISTS signalk `                                                                                   |
| No retention application has begun in this start; introspection for `signalk` answers `timestamp`; the other tables answer `ts`; every other statement returns an empty result     | Repair pass | The TTL statements sent are exactly, in order, `ALTER TABLE signalk SET TTL 0h`, `ALTER TABLE signalk_str SET TTL 0h`, `ALTER TABLE signalk_position SET TTL 0h`                                                                                                                                                                                                                      |
| Introspection for `signalk` answers `timestamp`; the `DROP TABLE` statement fails                                                                                                  | Repair pass | Log line `schema heal check failed: <error message>` at debug level; no further statement is sent in this pass; `signalk_str` and `signalk_position` are not introspected until the next pass                                                                                                                                                                                         |

### Statement-Timeout header

| Input / state | Action                      | Expected outcome                                         |
| ------------- | --------------------------- | -------------------------------------------------------- |
| Any statement | Send `SELECT 1` via `/exec` | Request header `Statement-Timeout` has the value `30000` |
