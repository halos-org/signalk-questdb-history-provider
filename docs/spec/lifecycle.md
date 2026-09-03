# Lifecycle

## Purpose

This surface covers what the plugin does between the server calling its `start` and the server calling its `stop`, and what the operator sees on the plugin's card under **Apps & Plugins -> Configuration** while that happens. At start the plugin waits for QuestDB's HTTP endpoint to answer, creates and repairs its three tables, opens the ILP write connection, registers itself as a v2 history API provider and as a v1 history provider, subscribes to the server's delta stream, applies the retention setting to the tables, and starts a periodic schema repair. At stop it tears all of that down in a fixed order and flushes what it has buffered. The plugin mounts no HTTP routes, emits no deltas into the server, saves no plugin options, and never asks the server to make it the default history provider.

## Interface constants

### Plugin object

| Constant              | Value                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| Plugin id             | `signalk-questdb-history-provider`                                       |
| Plugin name           | DISPLAY_NAME (chosen later; see the packaging surface)                   |
| Plugin object members | `id`, `name`, `schema`, `start`, `stop` and nothing else                 |
| `start` signature     | takes the stored configuration object; returns nothing                   |
| `stop` signature      | takes nothing; returns a promise that resolves when teardown is complete |

### Server API calls the plugin makes

| Server API                                    | When                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `app.setPluginStatus(text)`                   | status card, non-error line                                               |
| `app.setPluginError(text)`                    | status card, error line                                                   |
| `app.debug(...)`                              | diagnostic log lines listed below                                         |
| `app.error(text)`                             | the retention failure line listed below                                   |
| `app.registerHistoryApiProvider(provider)`    | v2 history API provider, once per start                                   |
| `app.registerHistoryProvider(provider)`       | v1 history (playback) provider, once per start, after the v2 registration |
| `app.streambundle.getBus().onValue(callback)` | delta stream subscription, once per start                                 |
| `app.selfContext`                             | read to decide which context is `self`                                    |

The plugin never calls `app.handleMessage`, `app.savePluginOptions`, `app.getDataDirPath`, `app.registerWithRouter`, or any HTTP endpoint of the server.

### Status card strings

| Kind   | Exact text                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Status | `Waiting for QuestDB to become ready...`                                                                                        |
| Status | `Creating tables...`                                                                                                            |
| Status | `Recording to QuestDB at <ilpHost>:<ilpPort>`                                                                                   |
| Error  | `QuestDB not responding at <httpHost>:<httpPort>`                                                                               |
| Error  | `Startup failed: <message>`                                                                                                     |
| Error  | `QuestDB keeps dropping the write connection — the container may be unhealthy or out of memory.`                                |
| Error  | `QuestDB keeps dropping the write connection — the container may be unhealthy or out of memory (<n> buffered samples dropped).` |

`<ilpHost>` and `<httpHost>` are both the configured `questdbHost`. `<ilpPort>` is the configured `questdbIlpPort`, `<httpPort>` the configured `questdbHttpPort`. `<message>` is the message of the error that ended the start. The dash in the last two strings is U+2014 EM DASH with one space on each side. `<n>` is a whole number greater than zero.

### Log lines

| Channel     | Exact text                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| `app.debug` | `connecting to QuestDB at %s:%d` with `<httpHost>`, `<httpPort>` as printf arguments |
| `app.debug` | `ILP connected to <ilpHost>:<ilpPort>`                                               |
| `app.debug` | `ILP socket error: <message>`                                                        |
| `app.debug` | `ILP connection dropped after <ms>ms (flap #<n>), retrying in <delay>ms`             |
| `app.debug` | `ILP write failed, re-queued batch: <message>`                                       |
| `app.debug` | `ILP socket drained, resuming writes`                                                |
| `app.debug` | `Rebuilt <table>: ILP had auto-created it with a wrong schema`                       |
| `app.debug` | `schema heal check failed: <message>`                                                |
| `app.debug` | `skipping queued start: plugin stopped while it waited`                              |
| `app.error` | `Could not apply the retention setting: <message>`                                   |

### Timing and limits

| Constant                        | Value                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Readiness probe request         | `GET http://<httpHost>:<httpPort>/exec?query=SELECT+1`                                                                   |
| Readiness probe timeout         | 5000 ms per request                                                                                                      |
| Readiness probe success         | HTTP status 2xx                                                                                                          |
| Readiness poll interval         | 500 ms between a failed probe and the next                                                                               |
| Readiness poll deadline         | 30000 ms from the first probe                                                                                            |
| SQL statement request           | `GET http://<httpHost>:<httpPort>/exec?query=<sql>` with header `Statement-Timeout: 30000` and a 30000 ms client timeout |
| SQL statement failure text      | `QuestDB query failed (<status>): <body>`                                                                                |
| ILP connection                  | plain TCP to `<ilpHost>:<ilpPort>`                                                                                       |
| ILP flush interval              | 5000 ms                                                                                                                  |
| ILP flush batch size            | 1000 lines                                                                                                               |
| ILP stable-connection threshold | 5000 ms                                                                                                                  |
| ILP reconnect delay             | 1000 ms initially, doubled per unstable close, capped at 30000 ms                                                        |
| ILP unhealthy threshold         | 5 consecutive unstable closes                                                                                            |
| ILP disconnected buffer cap     | 100000 lines; the oldest lines are dropped first                                                                         |
| Schema repair interval          | 60000 ms                                                                                                                 |
| Owned tables, in order          | `signalk`, `signalk_str`, `signalk_position`                                                                             |

### SQL issued during start and by the repair timer

| Purpose                    | Statement                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table creation             | `CREATE TABLE IF NOT EXISTS <table> (...)` for each of the three owned tables, in the order above; the column lists and table clauses are in the storage surface |
| Designated-timestamp check | `SELECT "column" FROM table_columns('<table>') WHERE designated = true`                                                                                          |
| Table rebuild              | `DROP TABLE IF EXISTS <table>` followed by the three table creation statements                                                                                   |
| Retention, days > 0        | `ALTER TABLE <table> SET TTL <days> DAYS` for each of the three owned tables, in order                                                                           |
| Retention, days = 0        | `ALTER TABLE <table> SET TTL 0h` for each of the three owned tables, in order                                                                                    |

## Behaviour

### Plugin object

1. The package entry point exports a factory function as its default export. The server calls it once with the app object and receives the plugin object.
2. The plugin object has exactly the members `id`, `name`, `schema`, `start`, and `stop`. `schema` is the configuration schema described in the configuration surface.
3. The plugin object declares no `registerWithRouter`, no `signalKApiRoutes`, no `getOpenApi`, and no `statusMessage`. The server therefore mounts no route for the plugin.
4. The package declares the keyword `signalk-node-server-plugin` and the keyword `signalk-category-database`, and no other `signalk-*` keyword. In particular it declares neither `signalk-plugin-configurator` nor `signalk-embeddable-webapp`, so the Admin UI renders the schema form and lists no webapp for the plugin.
5. The package declares no `signalk.requires` metadata.
6. No built runtime file of the package contains the string `_providers/_default` or the string `/signalk/v2` on a line that is not a whole-line comment. The plugin reaches the server only through the app object it was given, never over HTTP.

### Start sequence

The server does not await `start`. `start` returns at once; the work below runs asynchronously. The status card reflects each step as it happens. A restart after a configuration change is a `stop` followed by a `start`; every step below runs again on every start.

1. Read the configuration. Missing keys take the defaults in the configuration surface. Unknown keys are ignored: a stored configuration that carries keys the schema does not declare starts normally.
2. Resolve the endpoints: HTTP is `<questdbHost>:<questdbHttpPort>`, ILP is `<questdbHost>:<questdbIlpPort>`. A missing host is `127.0.0.1`, a missing HTTP port is `9000`, a missing ILP port is `9009`.
3. Log `connecting to QuestDB at %s:%d` with the HTTP host and port.
4. Set the status `Waiting for QuestDB to become ready...`.
5. Wait for QuestDB's HTTP endpoint:
   1. Send the readiness probe request. A 2xx status means ready. Any other status, a network error, or no answer within 5000 ms means not ready.
   2. While the endpoint is not ready and less than 30000 ms have elapsed since the first probe, send the next probe 500 ms after the previous one failed.
   3. After a probe succeeds, or after the 30000 ms deadline passes, the plugin sends one final probe. Whether the endpoint is ready is decided by that final probe alone. On the happy path the final probe is a second successful probe directly after the first (see _Observed defects_).
   4. If the final probe is not ready, set the error `QuestDB not responding at <httpHost>:<httpPort>` and end the start. Nothing is registered, nothing is subscribed, no timer runs, and the plugin does not retry on its own. The operator restarts the plugin (or the server) to try again.
   5. Because each probe may take up to 5000 ms, the wall-clock time before the error appears is between 30 s and roughly 40 s.
6. Set the status `Creating tables...`.
7. Issue the three table creation statements in order. A failed statement ends the start with the error `Startup failed: QuestDB query failed (<status>): <body>`; a network failure ends it with `Startup failed: <message>` where `<message>` is the underlying error text.
8. Run one schema repair pass (rules under _Schema repair_). Repair failures are logged and never end the start.
9. Open the ILP TCP connection to `<ilpHost>:<ilpPort>` and wait for the TCP connect to complete. On connect, log `ILP connected to <ilpHost>:<ilpPort>`; the 5000 ms flush interval and the 5000 ms stability window begin. A refused or otherwise failed connect ends the start with `Startup failed: <message>` (for example `Startup failed: connect ECONNREFUSED 127.0.0.1:9009`). See _Observed defects_ for what happens to the connection afterwards.
10. Register the v2 history API provider with `app.registerHistoryApiProvider`.
11. Register the v1 history provider with `app.registerHistoryProvider`. The v2 registration always precedes the v1 registration. The plugin never unregisters either; on every start it registers both again.
12. Subscribe to the server's delta stream with `app.streambundle.getBus().onValue`. From this moment on deltas are recorded per the ingestion surface. Deltas that arrive after stop began are discarded.
13. Apply retention: issue the retention statement for each owned table with the configured `retentionDays` (a missing value is 0; a fractional value is floored; a negative value is 0). A failure is logged as `Could not apply the retention setting: <message>` through `app.error` and the start continues. Retention is applied on every start, so a changed setting, including a change back to 0, takes effect on the next start.
14. Start the schema repair timer with a 60000 ms interval.
15. Set the status `Recording to QuestDB at <ilpHost>:<ilpPort>`.

The status card therefore shows, in order, `Waiting for QuestDB to become ready...`, `Creating tables...`, `Recording to QuestDB at <ilpHost>:<ilpPort>`. The two registrations and the subscription precede the first retention statement.

Any exception not handled above (thrown from any step) is caught and becomes the error `Startup failed: <message>`. `start` itself never rejects and never throws.

### Serialisation and abortability of start

1. Starts run one at a time. On a restart the server calls `stop` and then `start` while the earlier start may still be winding down; the new start waits until the earlier start has finished or bailed, then runs. Two starts never create QuestDB resources at the same time.
2. `stop` marks every start that is still waiting to run as cancelled. When such a start's turn comes it logs `skipping queued start: plugin stopped while it waited` and does nothing.
3. `stop` aborts the start that is currently running. The abort takes effect at the next point where that start waits. In every phase before the ILP connect completed, an aborted start registers no provider, subscribes to no stream, and starts no repair timer. What else happens depends on the phase the start is in when the stop lands:
   1. Waiting for QuestDB (the readiness poll of rule 5.2): the start ends. The card keeps `Waiting for QuestDB to become ready...`.
   2. The final readiness probe (rule 5.3): the stop is not honoured at this point (see _Observed defects_). If the probe fails, the card changes to `QuestDB not responding at <httpHost>:<httpPort>` after the stop. If the probe succeeds, the card changes to `Creating tables...` and then to `Startup failed: <message>`, where `<message>` is the runtime's text for a method call on a null value. No table creation statement is issued.
   3. Table creation or the start-time repair pass: a stop during table creation lets all three `CREATE TABLE` statements complete and then skips the start-time repair pass entirely, with no introspection query and no log line; a stop during the repair pass lets the statement in flight complete, and the pass may log one `schema heal check failed: <message>` line (_Schema repair_ rule 2) and checks no further table. In both cases the start goes on to the ILP connect. If the connect succeeds, the connection is closed at once and the start ends; the card keeps `Creating tables...`. If the connect fails, the card changes to `Startup failed: <message>` after the stop and the connection keeps reconnecting (see _Observed defects_). A table creation statement that fails after the stop landed also sets `Startup failed: <message>`.
   4. The ILP connect: the stop ends the connection. If the connect completes, the socket is closed and the start ends; the card keeps `Creating tables...`. If the connect fails, the card changes to `Startup failed: <message>` after the stop; no reconnect follows.
   5. After the ILP connect completed: see rule 4.
4. A stop that lands after the ILP connect completed does not abort the start. See _Observed defects_ for a stop that lands while the retention statements are in flight.
5. `stop` itself is not serialised behind a running start. It runs immediately.
6. Two `start` calls with no `stop` between them: the server never issues this sequence, and the behaviour is undefined.

### ILP connection health while recording

1. The ILP connection is a single TCP socket. Lines are buffered and written on the 5000 ms flush timer, or immediately when 1000 lines are buffered, or on stop. Line formats belong to the ILP wire format surface.
2. Every socket close is one of two kinds:
   1. **Stable close**: the socket had stayed open for at least 5000 ms. The reconnect delay was already reset to 1000 ms when the socket reached that age (rule 4). The plugin reconnects after the current delay and counts no flap.
   2. **Unstable close**: the socket closed before 5000 ms, including a failed connect attempt. The consecutive-flap count increments, the reconnect delay doubles up to the 30000 ms cap, and the plugin logs `ILP connection dropped after <ms>ms (flap #<n>), retrying in <delay>ms`.
3. On every unstable close with a consecutive-flap count of 5 or more, the plugin sets the error `QuestDB keeps dropping the write connection — the container may be unhealthy or out of memory.` When lines have been dropped from the buffer since the last healthy state, the text is instead `... out of memory (<n> buffered samples dropped).` with the count of dropped lines. This repeats on every further unstable close, with the count updated.
4. When a connection stays open for 5000 ms, the reconnect delay resets to 1000 ms and the consecutive-flap count resets to 0. If the connection had been marked unhealthy, the plugin then sets the status `Recording to QuestDB at <ilpHost>:<ilpPort>` and resets the dropped-line count used in the error text. If the connection had not been marked unhealthy, the card does not change.
5. While disconnected the plugin keeps at most 100000 lines. When the cap is exceeded the oldest lines are discarded. A batch whose socket write fails is put back at the front of the buffer and written again after reconnect, subject to the same cap.
6. The ILP socket connect is not gated by the readiness probe; only the HTTP endpoint is probed for readiness.
7. A socket error is logged as `ILP socket error: <message>` and is otherwise handled through the close rules above.

### Schema repair

1. A repair pass runs once during start (after table creation, before ILP connect) and then on every 60000 ms tick of the repair timer.
2. A pass is skipped when a previous pass is still running. No repair pass begins after stop. A pass that is in flight when stop runs is not cancelled: if it has tables left to check, it logs one `schema heal check failed: <message>` line after the stop and checks no further table (see _Observed defects_).
3. For each owned table in order `signalk`, `signalk_str`, `signalk_position`:
   1. Issue the designated-timestamp check statement.
   2. If the statement fails, or the table does not exist, or the table has no designated timestamp, the table is not repaired.
   3. If the designated-timestamp column is not named `ts`, the table was auto-created by ILP ingestion with the wrong shape: issue `DROP TABLE IF EXISTS <table>`, then the three table creation statements, then the retention statements with the most recently applied retention value, and log `Rebuilt <table>: ILP had auto-created it with a wrong schema`. Rows in the dropped table are lost.
4. Any error thrown during a pass is logged as `schema heal check failed: <message>` and ends that pass; the remaining tables in the pass are not checked. The next tick starts a fresh pass.
5. During the start-time pass, the most recently applied retention value is 0 (retention is applied later in the same start), so a table rebuilt at start receives `SET TTL 0h` and then the configured value at step 13 of the start sequence.

### Stop sequence

`stop` runs the following, in order, and its promise resolves after the last step:

1. Cancel every start that is still waiting to run and abort the start that is running (see _Serialisation and abortability of start_).
2. Unsubscribe from the delta stream. Errors thrown by the unsubscribe are ignored.
3. Stop the periodic schema repair.
4. Close the ILP connection:
   1. No reconnect happens after stop, and no further flush runs on the interval.
   2. If the socket is connected and lines are buffered, write them to the socket now.
   3. Half-close the socket (TCP FIN) and wait for the socket to end.
   4. If the socket is not connected, buffered lines are discarded.
   5. A stop that lands while a TCP connect is in flight waits for that connect to end (success, refusal, or the operating system's connect timeout for a host that does not answer); the `stop` promise resolves only then.
5. A later start begins with empty sampling windows and no remembered vessel names.

`stop` does not change the status card. The card keeps the last status or error text set before the stop. `stop` does not unregister the history providers; the server offers no call for that.

A `stop` with no start before it (or after a start that bailed) completes immediately.

### Default history provider

1. The plugin never calls the server's default-provider route and never writes `historyApi.defaultProvider`. Which provider is default is the operator's choice, set in the Admin UI or in `settings.json` with the server stopped. The server needs version 2.31.0 or newer to persist that choice.
2. With no default configured, the server uses whichever provider registered first. This plugin registers only after the HTTP endpoint answers, the tables exist, and the ILP connection is open, so a provider with no backend to wait for registers first.

### What the CI integration job asserts after install

The job runs on Node 22 and Node 24 against `signalk-server@latest` and a `questdb/questdb:10.0.0` service exposing ports 9000, 9009 and 8812.

1. Wait for `GET http://localhost:9000/` to succeed, polling every 2 s for up to 60 attempts.
2. Build the package, pack it into a tarball, install `signalk-server@latest` and the tarball into an empty directory.
3. Obtain the plugin id from the installed package: load `dist/plugin-id.js` and read its named export `PLUGIN_ID` (packaging surface). The job never assumes the id from the package name.
4. Write `plugin-config-data/<plugin id>.json` under the server's config directory with `{"enabled": true, "configuration": {"questdbHost": "127.0.0.1", "questdbHttpPort": 9000, "questdbIlpPort": 9009}}`.
5. Start the server on port 3000 with `--sample-nmea0183-data --sample-n2k-data --override-timestamps` and `SIGNALK_NODE_CONFIG_DIR` pointing at that directory.
6. Wait for `GET http://localhost:3000/signalk/v1/api/` to succeed, polling every 2 s for up to 60 attempts.
7. Assert that the JSON from `GET http://localhost:3000/skServer/plugins` contains the plugin id.
8. Poll `GET http://localhost:3000/signalk/v2/api/history/_providers` every 2 s for up to 30 attempts until its body contains the plugin id. Because the plugin registers only after QuestDB answers and the tables exist, this proves the whole start sequence up to registration, not only that the package loads.

## Cross-surface references

- Plugin id `signalk-questdb-history-provider`, exposed by the built package as the named export `PLUGIN_ID` of `dist/plugin-id.js`, and the DISPLAY_NAME placeholder (packaging surface).
- Configuration keys `questdbHost`, `questdbHttpPort`, `questdbIlpPort`, `retentionDays`, `pathFilter`, `samplingRates`, `recordSelf`, `recordOthers`, `defaultSamplingRate` and their defaults `127.0.0.1`, `9000`, `9009`, `0`, `exclude`/`[]`, `{}`, `true`, `true`, `2000` (configuration surface).
- Owned tables `signalk`, `signalk_str`, `signalk_position`, their designated timestamp column `ts`, and the `CREATE TABLE IF NOT EXISTS` statements (storage surface).
- SQL statements go over `GET /exec?query=<sql>` with header `Statement-Timeout: <ms>`; failures read `QuestDB query failed (<status>): <body>` (storage surface).
- Delta stream subscription via `app.streambundle.getBus().onValue`; the `self` context is the delta whose context equals `app.selfContext`; deltas that arrive after stop began are discarded (ingestion surface).
- ILP buffer cap 100000 lines, flush interval 5000 ms, batch size 1000 lines; after the disconnected buffer discards lines, the next vessel-name report per context is written again even if the name is unchanged (ingestion and ILP wire format surfaces).
- Status string `Recording to QuestDB at <ilpHost>:<ilpPort>` is set on the card's status line both at the end of start and on ILP recovery after an unhealthy period; the error line is set to the `QuestDB keeps dropping the write connection — ...` text on every unstable close at or past the fifth consecutive flap. The ILP wire format surface defines when these transitions occur; this file defines the card text.
- The v2 provider is registered with `app.registerHistoryApiProvider` and the v1 provider with `app.registerHistoryProvider` (history v2 and history v1 surfaces).

## Disagreements with the README

1. README, _Checking it works_: "If it stays on the waiting line, QuestDB's HTTP port is not answering." The plugin does not stay on the waiting line. Between 30 s and roughly 40 s after start it replaces it with the error `QuestDB not responding at <httpHost>:<httpPort>`.
2. README, _Checking it works_: "table creation and the ILP connection each report themselves". Both report through the same `Startup failed: <message>` line, where `<message>` is the underlying error text; the phase is not named.
3. README, _Choosing the default history provider_: "this plugin registers only after QuestDB answers and its tables exist". Registration additionally requires the ILP TCP connect to complete.

## Observed defects

1. ILP connect fails at start: the card shows `Startup failed: connect ECONNREFUSED <ilpHost>:<ilpPort>` (or the equivalent error text), no provider is registered and no stream subscription exists, yet the ILP connection keeps reconnecting in the background with backoff. On the fifth consecutive failed attempt, 30 s after the first (reconnect waits of 2000, 4000, 8000 and 16000 ms), the card changes to `QuestDB keeps dropping the write connection — ...`. If QuestDB's ILP port then comes up and the connection holds for 5 s, the card changes to `Recording to QuestDB at <ilpHost>:<ilpPort>` while nothing is recorded and nothing is served. If the connect succeeds before the fifth attempt the card stays on `Startup failed: ...` while, again, nothing is recorded. A plugin restart is the only recovery.
2. Stop landing while the retention statements of a start are in flight: the start continues past the stop. It starts a schema repair timer and sets the status `Recording to QuestDB at <ilpHost>:<ilpPort>` after the stop completed, so the card of a stopped plugin says it is recording. The stop did unsubscribe the stream and close the ILP connection, so nothing is recorded. The next start does not stop that periodic repair, so two repair passes then run every 60000 ms for the life of the process.
3. On the happy path the plugin sends two readiness probes before `Creating tables...`: the probe that succeeded and one final probe directly after it. The second probe is redundant and delays table creation by one HTTP round trip.
4. Stop landing during the final readiness probe is not honoured. The card changes after the stop: to `QuestDB not responding at <httpHost>:<httpPort>` when the probe fails, or to `Creating tables...` and then `Startup failed: <message>` when it succeeds, where `<message>` is the runtime's text for a method call on a null value.
5. Stop landing during table creation or the start-time repair pass, followed by a failed ILP connect: the card shows `Startup failed: <message>` after the stop, and the ILP connection keeps reconnecting with backoff. A stop that follows before any start closes it. In the server's restart sequence (`stop`, then `start`), the next start opens its own connection and the orphaned one is never closed: it reconnects for the life of the process, and its health transitions keep setting the card's error and status lines per _ILP connection health_.
6. A schema repair pass in flight when stop runs is not cancelled. If it has tables left to check, it logs one `schema heal check failed: <message>` line after the stop.

## Test cases

### Plugin object and built output

| Input / state                                            | Action                                                                                                  | Expected outcome                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Built package installed                                  | Require the package directory as the server does; take the default export or the module itself          | A function                                                                                                            |
| App object with only `debug`, `error`, `setPluginStatus` | Call the factory                                                                                        | Object with `id` equal to `signalk-questdb-history-provider`, a string `name`, a function `start`, a function `stop`  |
| App object as above                                      | Read the plugin's `schema` (call it if it is a function)                                                | An object schema of type `object`                                                                                     |
| Built package on disk                                    | Scan every built runtime file (not test files), ignoring whole-line comments, for `_providers/_default` | No file contains it                                                                                                   |
| Built package on disk                                    | Scan the same files for `/signalk/v2`                                                                   | No file contains it                                                                                                   |
| Package manifest                                         | Read `keywords`                                                                                         | Contains `signalk-node-server-plugin`; contains neither `signalk-plugin-configurator` nor `signalk-embeddable-webapp` |
| Package manifest                                         | Read `signalk.requires`, `dependencies`, `peerDependencies`                                             | No `signalk.requires`; no dependency on a container manager package                                                   |
| Package manifest                                         | Read `type` and `main`                                                                                  | `type` is `module`; `main` names a file that exists and is included in the published tarball                          |

### ILP connection health

| Input / state                                                                       | Action                                                          | Expected outcome                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A TCP listener on the ILP port that accepts and immediately closes every connection | Let the reconnects run                                          | On the fifth consecutive close the card shows the error `QuestDB keeps dropping the write connection — the container may be unhealthy or out of memory.`; the error repeats on every further close |
| Card shows the unhealthy error; the listener now keeps the connection open          | Wait longer than the stability window without any further close | The card shows `Recording to QuestDB at <ilpHost>:<ilpPort>`, driven by the stability window alone; no close is needed                                                                             |
| Connected, buffered lines                                                           | Stop                                                            | Buffered lines are written before the socket closes                                                                                                                                                |

### Integration (CI job)

| Input / state                                                                                                                                          | Action                                                                 | Expected outcome                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------- |
| QuestDB 10.0.0 reachable on 9000 and 9009; server installed with the packed plugin; plugin enabled with `questdbHost` `127.0.0.1`, ports 9000 and 9009 | Start the server with sample data                                      | `GET /skServer/plugins` lists the plugin id |
| Same                                                                                                                                                   | Poll `GET /signalk/v2/api/history/_providers` every 2 s for up to 60 s | The response body contains the plugin id    |
| Same, Node 22 and Node 24                                                                                                                              | Run the job on each                                                    | Both pass                                   |
