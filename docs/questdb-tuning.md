# Running QuestDB under this plugin

Everything here is about the database, not the plugin. The plugin connects to a
QuestDB you run and has no setting that changes any of it.

Every setting below is a `server.conf` key with a matching environment
variable: uppercase it and replace the dots, so `cairo.commit.mode` becomes
`QDB_CAIRO_COMMIT_MODE`. **In a container, set the variable.** The environment
wins where both name the same key
([configuration overview](https://questdb.com/docs/configuration/overview)), so
editing `server.conf` inside a container does nothing if the compose file also
sets it. That edit also disappears on the next recreate, unless the QuestDB
root directory is a mounted volume.

**Durability** is what to decide before you record anything, and **Idle CPU** is
what to read on Raspberry Pi-class hardware, where QuestDB's idle polling costs
more than the ingest does. The rest is worth reading when you are sizing a
low-power host, or when you are trying to explain something QuestDB's own
console is telling you.

**Verified against QuestDB 10.0.0.** Property names move between releases --
`wal.apply.worker.count` was `cairo.wal.apply.worker.count` in earlier ones --
so check anything here against
[the configuration reference](https://questdb.com/docs/configuration/) for the
version you run. Where a setting's behaviour is version-specific, the text says
so.

**On HaLOS, the QuestDB container app applies all of this.** It lowers the
worker sleep thresholds, sizes the worker pools, and exposes the log level and
the commit mode as config fields. Its memory cap is declared but inert on a
kernel booted with `cgroup_disable=memory`, which is how Raspberry Pi OS ships
today -- verify rather than assume, since a distribution can change that
between releases and the checks under **Sizing on a low-power host** are the
source of truth.

## Durability: `cairo.commit.mode`

QuestDB's default is `nosync`, which fsyncs nothing on the ingest path. An
unclean shutdown then costs recent writes, and in one observed case cost the
whole table: `TableWriter` asserted while _opening_ the partition, so no
`RESUME WAL` variant ran early enough to repair it. On hardware that
can lose power without an orderly shutdown, set `cairo.commit.mode=sync`. It
fsyncs partition columns before the commit record is written, and cost about
1.3% of a CPU core on a HALPI2 at 139 rows per second. On HaLOS it is the
QuestDB app's **Commit Mode** setting.

That guarantee is only as good as the storage under it. `sync` reduces the risk
of a power cut, it does not remove it: consumer SD cards and USB bridges with
volatile write caches routinely acknowledge an fsync that has not reached the
medium, and the filesystem and driver have to honour the flush too. On cheap
flash, treat `sync` as narrowing the window rather than closing it.

## Idle CPU: worker sleep thresholds

Each QuestDB worker pool spins for `sleep.threshold` poll cycles before it
sleeps. The default is 10000, which on a mostly idle database keeps threads
burning CPU on work that never arrives. This is the long-standing complaint in
[questdb#3512](https://github.com/questdb/questdb/issues/3512), and it is a
fixed floor rather than a cost that scales with your data.

Measured on a HALPI2 taking 139 rows per second from this plugin, the container
held 8.5% of a core. Under 0.3% of that was ingest: ILP socket I/O took 3.1%
and the logging thread 1.4%. Injecting a further 1000 rows per second moved the
total to 21.5%, which puts the marginal cost near 0.013% of a core per row per
second and the rest in the floor.

There is no global default, so the threshold is per pool and a pool you leave
out keeps the full spin. Set them in `server.conf`, or as the matching `QDB_*`
variables:

```ini
shared.worker.sleep.threshold=100
line.tcp.io.worker.sleep.threshold=100
line.tcp.writer.worker.sleep.threshold=100
wal.apply.worker.sleep.threshold=100
view.compiler.worker.sleep.threshold=100
mat.view.refresh.worker.sleep.threshold=100
live.view.refresh.worker.sleep.threshold=100
export.worker.sleep.threshold=100
```

`shared.worker.sleep.threshold` covers three pools: the network, query and
write pools each fall back to it, and they serve the HTTP console and the pg
wire protocol. The split `shared.network` / `shared.query` / `shared.write`
names take a `count` but no threshold, and QuestDB refuses to start if you try
one, naming the key it rejected -- provided `config.validation.strict` is on.
QuestDB's own built-in default for that is `false`, but the `server.conf` it
ships sets it to `true` on line 2, so you have the strict behaviour unless you
removed that line or configure without a `server.conf` at all.

That check never covers the environment. A misspelled `QDB_*` variable is
ignored without a word whatever `config.validation.strict` says, so verify a new
setting against the running process rather than against a container that came
up.

The last four pools serve view compilation, materialised views, live views and
export. Nothing in this plugin uses them and their workers poll regardless,
which is the point -- an unused feature is exactly the pool nobody thinks to
set.

The companion `yield.threshold` settings that the same issue thread recommends
made no measurable difference once the sleep thresholds were low.

Worker counts matter alongside the thresholds, because QuestDB sizes most pools
from the core count. `line.tcp.io.worker.count` and
`line.tcp.writer.worker.count` are the trap. Zero is their default, and for
every other pool zero means "use the shared pool" -- but not for these two.
`Services.asLegacy` rewrites the count as `n > 0 ? n : 2`, because ILP's jobs
key per-worker state by worker id and the shared pools would reject those
assignments. So a zero there yields a dedicated pool of exactly two threads,
whatever the core count, until you set it to one. Verified in QuestDB 10.0.0
and by counting threads in the running JVM.

Logging is the other half. QuestDB records every WAL commit at INFO, which is
several lines a second of pure narration. Set `w.stdout.level=ERROR` in
`log.conf`, or `QDB_LOG_W_STDOUT_LEVEL=ERROR`. A level is a floor rather than
an exact set, so ERROR still carries CRITICAL and ADVISORY: table suspension,
ILP parse failures and the `max_map_count` warning all survive. What it drops
is the INFO band, and that band carries the WAL apply memory-pressure backoff
that precedes a suspension -- so raise it to INFO while diagnosing a database
that has stopped recording, and put it back afterwards.

Together, on the HALPI2 above, this took 8.5% of a core to 3.0%, with the
history API answering in 19ms and WAL apply keeping pace at one worker.

## Sizing on a low-power host

Neither of these is something the plugin controls.

**Cap memory and CPU.** On a board also hosting Grafana or other services,
768 MB and 1.5 cores leave room for them. The JVM sizes its heap from the cgroup
limit, so capping bounds heap and off-heap together.

Check that the memory cap can take effect at all. Raspberry Pi OS boots with
`cgroup_disable=memory`, so the kernel has no memory controller: a container
memory limit is accepted and then ignored, and `docker stats` reports 0B for
every container. The CPU cap is unaffected.

`cat /proc/cmdline` tells you directly. To check the controller itself, the path
depends on the cgroup version -- `stat -fc %T /sys/fs/cgroup` reports `cgroup2fs`
or `tmpfs`:

```bash
# cgroup v2
cat /sys/fs/cgroup/cgroup.controllers          # is "memory" listed?
# cgroup v1
ls -d /sys/fs/cgroup/memory                    # does the controller exist?
```

**Reduce worker threads to 1 each.** `wal.apply.worker.count`,
`shared.worker.count`, `line.tcp.writer.worker.count`, `line.tcp.io.worker.count`,
`view.compiler.worker.count`, `mat.view.refresh.worker.count` and
`live.view.refresh.worker.count`. Only `shared.worker.count` covers more than
its own pool -- it still sets all three shared pools in QuestDB 10 despite the
split. Note that the WAL apply property has no `cairo.` prefix -- QuestDB
ignores an unrecognised environment variable silently, so a wrong name here
looks exactly like a setting that took effect.

## Commit size and the WAL

The plugin commits its write buffer every five seconds, or as soon as 1000
samples have accumulated, whichever comes first. Each commit is one WAL
transaction per table. Neither figure is configurable.

With deduplicated tables, the apply cost of a transaction grows with partition
size, so frequent tiny commits eventually outpace what a Pi can apply and
recording stalls. Bigger batches keep the WAL healthy. The cost is that a hard
crash loses at most one interval of buffered samples -- a clean Signal K
shutdown flushes first.

That bound assumes the write connection is up. While QuestDB is unreachable
nothing can be committed, so the buffer grows instead, to 100,000 lines; past
that the oldest lines are dropped to bound memory. An outage therefore costs
more than one interval whether or not anything crashes, and a connection that
keeps failing puts the dropped count on the plugin's status line.

### The "Small transactions -- consider batching" alert

QuestDB's Monitoring view flags any table whose 90th-percentile WAL transaction
stays under its recommended batch size of 100 rows. `signalk_position` triggers
this **structurally**: each commit is one WAL transaction per table, and the
position table holds exactly one path -- so its share of every commit is just
the fixes recorded since the last one. The other tables spread hundreds of paths across each
transaction and are rarely flagged.

So expect the alert on that table. Whether it costs you anything is a separate
question, and the numbers next to it answer it: **Write Amplification** near 1x,
**Pending Rows** 0 and **Transaction Lag** 0 mean the WAL apply has no current
backlog to work through. Small transactions do carry per-transaction apply
overhead, and on Pi-class hardware that is what eventually makes apply fall
behind -- those three are where it shows first. They do not say that a table is
unsuspended, and they are not a completeness check either. `wal_tables()`
answers both directly: `suspended`, and `writerTxn` against `sequencerTxn` --
equal means every committed transaction has been applied and is visible to
queries. Whether the writes were sent at all is a question for the source, not
for QuestDB.

If those numbers say the apply is genuinely falling behind, the lever is the
**Sampling rate**: fewer rows per second is fewer rows to apply, and it is a
choice about the resolution you want rather than about buffer mechanics.
Clearing the position table's alert needs roughly 100 fixes in one commit, which
typical position rates do not reach: how many arrive depends on the source
cadence, on how many vessels you record, and on which flush threshold fires
first -- and a rate high enough to fill the buffer commits sooner, which works
against it.

## Further reading

[QuestDB capacity planning](https://questdb.com/docs/getting-started/capacity-planning/)
covers both settings above and the rest of QuestDB's own tuning advice.
