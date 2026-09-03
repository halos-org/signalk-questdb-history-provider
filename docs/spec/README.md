# Behavioural specification

These files describe what the plugin does, as seen from outside it: what the Signal K server hands it, what it sends to QuestDB, what it answers to history requests, and what the operator sees. They are written so that an implementer who has never seen the plugin can build it from them, and they are the reference for its behaviour.

The files describe surfaces, not source files. A surface is one boundary of the plugin: the npm package, the configuration form, the plugin lifecycle, the delta stream in, the ILP socket out, the SQL transport, and the two history APIs. A name such as "the storage surface" refers to the file of that name below.

## Files

| File                                     | Surface                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [packaging.md](packaging.md)             | The npm package, the plugin object the server loads, and what CI asserts after installing it                                                         |
| [configuration.md](configuration.md)     | The configuration schema, the effective value of each key, and the README configuration table                                                        |
| [lifecycle.md](lifecycle.md)             | Start and stop, status card text, provider registration, timers, log lines                                                                           |
| [ingestion.md](ingestion.md)             | Delta subscription, identity deltas, drops, context normalisation, path filter, sampling, which table each value kind lands in, one-level flattening |
| [ilp-wire-format.md](ilp-wire-format.md) | The ILP lines on the TCP socket, timestamps, batching, buffering, reconnect, health reports                                                          |
| [storage.md](storage.md)                 | Table DDL, schema repair, retention TTL, the HTTP SQL transport, validators                                                                          |
| [history-v2.md](history-v2.md)           | The v2 History API provider: time-range resolution, parameters, SQL, aggregates, fallbacks, response shapes                                          |
| [history-v1.md](history-v1.md)           | The v1 playback provider: windows, pacing, delta reconstruction, snapshots                                                                           |

Read them in that order. Each file lists the constants other files depend on under its Cross-surface references heading.

## Constants shared across surfaces

| Constant                             | Value                                                                     | Owning file     |
| ------------------------------------ | ------------------------------------------------------------------------- | --------------- |
| Package name and plugin id           | `signalk-questdb-history-provider`                                        | packaging       |
| Built module exposing the id         | `dist/plugin-id.js`, named export `PLUGIN_ID`                             | packaging       |
| Display name                         | `DISPLAY_NAME`, a placeholder until chosen                                | packaging       |
| Tables                               | `signalk`, `signalk_str`, `signalk_position`                              | storage         |
| Designated timestamp column          | `ts`, server receive time, microsecond precision in storage               | storage         |
| Wire timestamp unit                  | nanoseconds, with a monotonic floor of one microsecond                    | ilp-wire-format |
| Own-vessel context as stored         | `self`; other contexts stored verbatim                                    | ingestion       |
| Value kind tags                      | `boolean`, `identity`, or absent                                          | ingestion       |
| Identity row path                    | `name`                                                                    | ingestion       |
| Default host and ports               | `127.0.0.1`, HTTP `9000`, ILP `9009`                                      | configuration   |
| Status strings                       | Listed verbatim in lifecycle                                              | lifecycle       |
| Identifier pattern and error strings | `^[a-zA-Z0-9_.:-]+$`, `Invalid identifier: <v>`, `Invalid timestamp: <v>` | storage         |
| HTTP query error string              | `QuestDB query failed (<status>): <body>`                                 | storage         |
| Time to the fifth connection flap    | 30000 ms after the first failure (waits of 2000, 4000, 8000, 16000 ms)    | ilp-wire-format |

## Where the README and the code disagree

The specification records the code's behaviour. Each file lists its own items under Disagreements with the README; this is the collated list. The README needs these corrections.

- packaging: the Installing section tells the operator to search the store for the current display name; it must carry the chosen `DISPLAY_NAME`.
- lifecycle: the card does not "stay on the waiting line" when QuestDB is unreachable; after the poll it shows `QuestDB not responding at ...`. Table creation and the ILP connection do not "each report themselves"; both surface as `Startup failed: <message>`. Registration waits for the ILP connection as well as for QuestDB and the tables.
- ingestion: sampling is per path and per vessel context, not "per path". Per-path rates accept exact paths as well as globs, and an exact pattern wins. Filter patterns without glob characters match by exact equality. Only `navigation.position` goes to the position table, not "positions" in general. Flattening of object values is one level deep.
- storage: a table-creation failure surfaces as `Startup failed: <message>`, not as its own report. Retention floors fractional days, treats negatives as zero, and sends `SET TTL 0h` explicitly. The schema repair that drops and recreates an owned table is undocumented.
- history-v2: the aggregate list omits `middle_index`, which the provider accepts.

## Observed defects

Each file records defects under its Observed defects heading as current behaviour, with the observable symptom. This is the collated list, for filing as issues. An implementer reproduces the behaviour as specified; fixing a defect is a separate change with its own issue.

- packaging: `engines.node >=22` admits Node 22.0 to 22.11, which cannot `require` an ES module without a flag; the tarball carries compiled tests, repository documentation, and any untracked working-tree directory.
- configuration: a `samplingRates` value of `0` is ignored and the path falls back to the default rate; `pathFilter.mode` is not validated, so any value other than `exclude` selects include mode; an empty-string `questdbHost` is used verbatim and reports `QuestDB not responding at :9000`; a non-numeric `defaultSamplingRate` admits every update silently; a non-numeric `retentionDays` clears the TTL silently.
- lifecycle: an ILP connect failure at start leaves `Startup failed:` on the card while the connection keeps reconnecting, and a later stable connection shows `Recording ...` although nothing was registered; a stop landing during the retention statements is not aborted, leaving a second repair timer and the `Recording ...` status text on a stopped plugin; a stop landing during the final readiness probe or during the ILP connect is not honoured either, so the card can change after the stop and a failed connect keeps reconnecting; a repair pass in flight at stop may log one failure line after it; the happy path sends one redundant readiness probe.
- ingestion: meta deltas are flattened into rows such as `<path>.units`; a literal exclude pattern naming an object-valued path excludes none of its leaves; sampling windows use the raw wall clock, so a backwards clock step blocks affected pairs; a data path literally named `name` shares a sampling window with identity rows; a delta whose `context` is not a string throws a `TypeError` out of the subscription callback; a `navigation.position` value with extra properties such as `altitude` loses them; an identity report with `mmsi` but no usable `name` records nothing, and `mmsi` is never recorded.
- ilp-wire-format: a newline in a tag value or a string field value splits the line; the first retry after a cold failure waits 2000 ms, not 1000 ms; a rejected first connect keeps reconnecting in the background; the error line is re-set on every flap past the fifth; the backpressure drain line can log several times in one episode; lines buffered while disconnected are discarded uncounted on disconnect; the final write on disconnect is not waited for, and its lines are lost uncounted if it fails; several batches pending on a failed socket are re-queued in reverse order; data the local kernel had accepted before a peer reset is lost uncounted; more than ten flushes in one backpressure episode print a listener warning on stderr.
- storage: a repair pass stops at the first table whose step throws; the start-up repair runs before retention is applied, so a rebuilt table briefly carries `TTL 0h`; the timestamp validator accepts a bare digit string as a year; the health probe sends no `Statement-Timeout`.
- history-v2: position columns report the requested method although `first` was applied; unknown aggregate names run `avg` and are echoed under the unknown name; string-only paths requested with a client-side aggregate return an empty column; `middle_index` ignores `resolution`; an empty-string `context` is rejected as an invalid identifier; raw reads truncate silently at 10000 or 50000 rows; the bucket-guard message counts paths differently from the guard arithmetic; numeric `duration: 0` is treated as absent; a duration with a day, week, month, or year component fails with HTTP 400; a negative duration produces an inverted range with zero rows and no error; sub-millisecond digits in `from` and `to` are echoed in the response but floored in the SQL predicate.
- history-v1: snapshot deltas carry the literal context `self` while playback maps it to the server's self context; playback past the newest row polls every 100 ms indefinitely; a permanent query failure retries and logs once per second forever; an exception from the socket write is treated as a read error and the window is re-sent; a `NaN` playback rate runs unpaced; a full page whose rows all share one millisecond skips the rest of that millisecond; position text with more than two parts decodes from the first two.
