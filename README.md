# signalk-questdb-history-provider

QuestDB history provider for Signal K -- a drop-in replacement for signalk-to-influxdb and signalk-to-influxdb2.

It records the vessel data Signal K carries -- numbers, strings, booleans, positions, and the scalar leaves of object values -- into QuestDB, and serves it back through both the modern v2 History API and the legacy v1 playback API. It connects to a QuestDB you run; running the database is not the plugin's job.

## Requirements

- **Node.js 22 or newer**
- **Signal K server 2.19 or newer** -- when `registerHistoryApiProvider()` and the v2 History API arrived ([signalk-server#2100](https://github.com/SignalK/signalk-server/pull/2100)). Two later features are called out where they appear: 2.29 for per-source queries, 2.31 to persist a default-provider choice.
- **A QuestDB you run**, reachable from the Signal K process

## Installing

The plugin is on npm as `signalk-questdb-history-provider` and carries the `signalk-node-server-plugin` keyword, so it appears in the server's own App Store:

In the admin UI, open **Apps & Plugins -> Store**, search for _QuestDB History_, install it, and restart the server when prompted. (Servers older than 2.27 call the same two pages **Appstore** and **Server -> Plugin Config**.)

Or install it into the Signal K data directory yourself:

```bash
cd ~/.signalk
npm install signalk-questdb-history-provider
```

Either way the plugin appears under **Apps & Plugins -> Configuration** after a restart. It stays disabled until you enable it.

## Setting up QuestDB

You need a QuestDB instance before the plugin can do anything. Take it from [questdb.com](https://questdb.com/) -- container image, tarball or package, whichever suits the host.

**On HaLOS, install the QuestDB container app instead.** It arrives preconfigured for this plugin, with both settings below already applied.

Everywhere else, decide `cairo.commit.mode` before you record anything -- it sets what an unclean shutdown costs. That setting, how to cut QuestDB's idle CPU use on a Raspberry Pi-class board, and how to size it there are in [Running QuestDB under this plugin](docs/questdb-tuning.md).

## Pointing the plugin at QuestDB

In **Apps & Plugins -> Configuration -> QuestDB History**, enable the plugin and set **QuestDB host** plus the HTTP and ILP ports to wherever your QuestDB listens. The defaults (`127.0.0.1`, `9000`, `9009`) are QuestDB's own, and are right when both run on the same host.

The plugin makes ordinary outbound connections to those ports. It publishes nothing and opens no ports of its own.

If Signal K itself runs in a container, `127.0.0.1` is that container's loopback, not the host's. Point the plugin at the address QuestDB is reachable on from inside the Signal K container.

Everything else has a working default. See [Configuration](#configuration) for the full set.

## Checking it works

The plugin's card under **Apps & Plugins -> Configuration** is the quickest signal. It passes through `Waiting for QuestDB to become ready...` and `Creating tables...` on the way up, and settles on:

```text
Recording to QuestDB at 127.0.0.1:9009
```

If it stays on the waiting line, QuestDB's HTTP port is not answering -- check the host and port first. Any other error names what failed: table creation and the ILP connection each report themselves, and each needs a different fix.

Once it is recording, ask the server for the data back:

```http
GET /signalk/v2/api/history/values?paths=navigation.speedOverGround&duration=PT5M&resolution=10
```

Or query QuestDB directly from its own web console, which is on its HTTP port:

```sql
SELECT count(), max(ts) FROM signalk
```

A rising count and a recent `max(ts)` mean rows are landing.

## Choosing the default history provider

Several plugins can provide history, and the server records which one is default in `settings.json`. This plugin never claims that slot.

Set the default in the admin UI, or write `historyApi.defaultProvider` in `settings.json` **with the server stopped** -- a running server reads that key once at startup and rewrites the file from memory on the next settings save, discarding a live hand edit. Signal K needs 2.31.0 or newer to persist it; before that the setting was in-memory only.

With no default configured, the server uses whichever provider registered first. That is not a coin toss: this plugin registers only after QuestDB answers and its tables exist, so a logging plugin with no backend to wait for wins. Configure the default when more than one is installed.

## Configuration

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

**Per-path sampling rates (ms)** takes a JSON object mapping a glob pattern to an interval in milliseconds, so a critical path can run faster than the default while slow-changing ones stay throttled:

```json
{ "environment.wind.*": 200 }
```

## Reading the history

### v2 (REST -- `/signalk/v2/api/history/`)

Registered via `app.registerHistoryApiProvider()`. Supports all aggregate methods:

| Method    | QuestDB mapping                        |
| --------- | -------------------------------------- |
| `average` | `avg(value)`                           |
| `min`     | `min(value)`                           |
| `max`     | `max(value)`                           |
| `first`   | `first(value)`                         |
| `last`    | `last(value)`                          |
| `mid`     | `(min + max) / 2`                      |
| `sma`     | Client-side N-sample moving average    |
| `ema`     | Client-side exponential moving average |

`sma` reads its window and `ema` its alpha from a further colon-separated postfix (`navigation.speedOverGround:sma:10`). A window must be a whole number of at least 1, and an alpha must be within `0 < alpha <= 1`. Anything else, an absent parameter included, takes the default window of 5 or alpha of 0.2. The server strips `-`, `+` and spaces from `paths` before this plugin sees them, so a signed parameter arrives unsigned: `ema:-0.5` is read as an alpha of 0.5 rather than taking the default.

Both are computed here rather than by QuestDB, over raw samples. `resolution` does not bucket them: those columns come back at storage density, up to 50000 points per path.

```http
GET /signalk/v2/api/history/values?paths=navigation.speedOverGround&duration=PT1H&resolution=60
```

Append `|<sourceRef>` to a path to read one source's rows only (server 2.29+, [signalk-server#2737](https://github.com/SignalK/signalk-server/pull/2737)). The same path may appear once per source, giving one column per receiver:

```http
GET /signalk/v2/api/history/values?paths=navigation.position|gps.main,navigation.position|gps.backup&duration=PT1H
```

Without a sourceRef a path returns all sources mixed, as before.

### v1 (WebSocket playback)

Registered via `app.registerHistoryProvider()`. Supports playback at configurable speed multipliers using chunked reads from QuestDB. Replayed updates carry the recorded sourceRef as `$source`, one update per source, so consumers see the same attribution the live stream had.

### Grafana

Connect Grafana to QuestDB through its PostgreSQL data source, pointed at QuestDB's PGWire port (8812 by default) with database `qdb`. `admin`/`quest` is QuestDB's default PGWire account, and it is not read-only. Configuring a read-only user and replacing that password is QuestDB administration -- its [PGWire settings](https://questdb.com/docs/configuration/postgres-wire-protocol) cover both -- and it wants doing before the port is reachable from anywhere you do not control.

Whether Grafana can reach the port at all is between Grafana and QuestDB. This plugin is not in the path and has no setting that affects it.

```sql
SELECT ts AS time, avg(value) AS sog
FROM signalk
WHERE path = 'navigation.speedOverGround'
  AND context = 'self'
  AND ts BETWEEN $__timeFrom() AND $__timeTo()
SAMPLE BY $__interval
```

## Tuning for a Pi

**Sampling rate** carries most of the load on a low-power host. It bounds how often any one path is written, which keeps write volume modest on a busy NMEA 2000 bus. Raise individual paths with per-path overrides rather than lowering the default for everything; the defaults are in [Configuration](#configuration) above, chosen for Pi-class hardware.

Sizing QuestDB itself -- memory and CPU caps, worker threads, and the "Small transactions" alert its console raises against `signalk_position` -- is in [Running QuestDB under this plugin](docs/questdb-tuning.md).

## Schema

The plugin creates and owns three tables, all with WAL mode, daily partitioning and deduplication. It touches nothing else in the database, so an instance is safe to share.

| Table              | Purpose        | Columns                                                                                                    |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `signalk`          | Numeric values | `ts`, `path` (SYMBOL), `context` (SYMBOL), `source` (SYMBOL), `value` (DOUBLE)                             |
| `signalk_str`      | String values  | `ts`, `path` (SYMBOL), `context` (SYMBOL), `source` (SYMBOL), `value_str` (VARCHAR), `value_kind` (SYMBOL) |
| `signalk_position` | Positions      | `ts`, `context` (SYMBOL), `source` (SYMBOL), `lat` (DOUBLE), `lon` (DOUBLE)                                |

`ts` is the **server receive time**, not the timestamp a source claims. Marine sources carry independent clocks, and storing their timestamps makes commits land out of order -- QuestDB then rewrites partition tails on every merge (observed as >3000x write amplification). Receive time keeps ingestion append-only; the millisecond difference is far below the sampling resolution, and a device with a broken clock gets more accurate history, not less.

`source` is the delta's sourceRef -- which receiver produced the row. Two GPS units feeding the same server interleave in storage, and without the column a track drawn from history zigzags between them. Rows recorded before the column existed have `source` null; they replay unattributed and cannot be filtered.

## Troubleshooting

### History stops at a fixed moment and never advances

The table is WAL-suspended. QuestDB commits every ILP batch to its sequencer, then applies it in the background; when apply fails it stops that table. Writes keep succeeding, this plugin keeps reporting `Recording`, and queries keep answering -- with a series that ends the moment apply stopped. Nothing raises an error at either end.

Ask QuestDB directly:

```sql
SELECT name, suspended, writerTxn, sequencerTxn, errorTag, errorMessage
FROM wal_tables() WHERE suspended = true
```

Read `errorTag` and `errorMessage` first: they name QuestDB's own reason where it has one, and a resource cause -- a full disk, or an exhausted memory-mapping limit on Linux, which `vm.max_map_count` raises -- has to be fixed before anything else is worth trying. Then restart QuestDB, which resumes every suspended table and clears the causes that have since gone away.

If it suspends again, that on its own does not prove the data is unreadable; a resource problem that is still present looks identical. Rule that out, and only then consider skipping past the transaction: `ALTER TABLE <name> RESUME WAL FROM TXN <n>` does not replay what it skips, so the rows in those transactions are gone. Identify the failed transaction with `wal_transactions('<table>')` before choosing `n`. This repository pins no QuestDB version -- check the recovery syntax against the one you run.

The usual causes are a full disk and a power cut against QuestDB's default `nosync` -- [Running QuestDB under this plugin](docs/questdb-tuning.md) covers the second one.

**Retention is off by default.** A recording that never expires fills any card eventually, and a full disk is one of the causes above. **Retention (days)** sets a TTL on the tables so QuestDB drops partitions past that age, which bounds the space history can take; leave it at 0 only where the disk can hold everything you record.

## License

MIT
