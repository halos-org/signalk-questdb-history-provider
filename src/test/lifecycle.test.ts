// The lifecycle surface: the plugin object, the start sequence against a
// scripted QuestDB and a TCP peer, stop, and the abort points.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPlugin, type HistoryPlugin } from "../index.js";
import { PRODUCTION_TIMING, type LifecycleTiming } from "../lifecycle.js";
import { fakeApp, type FakeApp } from "./fake-app.js";
import {
  closedPort,
  delay,
  emptyResult,
  startFakeIlpPeer,
  startFakeQuestDb,
  waitFor,
  type FakeIlpPeer,
  type FakeQuestDb,
  type ScriptedAnswer,
} from "./helpers.js";

const TIMING: LifecycleTiming = {
  readinessPollIntervalMs: 20,
  readinessDeadlineMs: 200,
  schemaRepairIntervalMs: 100000,
};

describe("plugin object", () => {
  it("has exactly id, name, schema, start and stop", () => {
    const plugin = createPlugin(fakeApp());
    assert.deepEqual(Object.keys(plugin).sort(), [
      "id",
      "name",
      "schema",
      "start",
      "stop",
    ]);
    assert.equal(plugin.id, "signalk-questdb-history-provider");
    assert.equal(typeof plugin.name, "string");
    assert.equal((plugin.schema as { type: string }).type, "object");
  });

  it("uses the production timing by default", () => {
    assert.deepEqual(PRODUCTION_TIMING, {
      readinessPollIntervalMs: 500,
      readinessDeadlineMs: 30000,
      schemaRepairIntervalMs: 60000,
    });
  });

  it("stop with no start completes at once", async () => {
    await createPlugin(fakeApp()).stop();
  });
});

interface World {
  app: FakeApp;
  questdb: FakeQuestDb;
  peer: FakeIlpPeer;
  plugin: HistoryPlugin;
  config: Record<string, unknown>;
}

describe("start sequence", () => {
  const worlds: World[] = [];

  async function world(config: Record<string, unknown> = {}): Promise<World> {
    const app = fakeApp();
    const questdb = await startFakeQuestDb();
    const peer = await startFakeIlpPeer();
    const w: World = {
      app,
      questdb,
      peer,
      plugin: createPlugin(app, TIMING),
      config: {
        questdbHost: "127.0.0.1",
        questdbHttpPort: questdb.port,
        questdbIlpPort: peer.port,
        ...config,
      },
    };
    worlds.push(w);
    return w;
  }

  afterEach(async () => {
    for (const w of worlds.splice(0)) {
      await w.plugin.stop();
      await w.questdb.close();
      await w.peer.close();
    }
  });

  const recording = (w: World): string =>
    `Recording to QuestDB at 127.0.0.1:${w.peer.port}`;

  it("runs the happy path in order", async () => {
    const w = await world({ retentionDays: 7 });
    w.plugin.start(w.config);
    await waitFor(() => w.app.statuses.includes(recording(w)));

    assert.deepEqual(w.app.statuses, [
      "Waiting for QuestDB to become ready...",
      "Creating tables...",
      recording(w),
    ]);
    assert.deepEqual(w.app.errors, []);
    assert.equal(
      w.app.debugLines[0],
      `connecting to QuestDB at %s:%d 127.0.0.1 ${w.questdb.port}`,
    );
    assert.ok(
      w.app.debugLines.includes(`ILP connected to 127.0.0.1:${w.peer.port}`),
    );

    const probes = w.questdb.queries.filter((q) => q === "SELECT 1");
    assert.equal(probes.length, 2);
    const statements = w.questdb.queries.filter((q) => q !== "SELECT 1");
    assert.ok(statements[0].includes("CREATE TABLE IF NOT EXISTS signalk ("));
    assert.ok(
      statements[1].includes("CREATE TABLE IF NOT EXISTS signalk_str ("),
    );
    assert.ok(
      statements[2].includes("CREATE TABLE IF NOT EXISTS signalk_position ("),
    );
    assert.ok(statements[3].startsWith('SELECT "column" FROM table_columns'));
    assert.deepEqual(statements.slice(6), [
      "ALTER TABLE signalk SET TTL 7 DAYS",
      "ALTER TABLE signalk_str SET TTL 7 DAYS",
      "ALTER TABLE signalk_position SET TTL 7 DAYS",
    ]);
    assert.equal(w.app.v2Providers.length, 1);
    assert.equal(w.app.v1Providers.length, 1);
    assert.equal(w.app.listeners.length, 1);
  });

  it("registers v2 before v1 and both before the first retention statement", async () => {
    const w = await world();
    const order: string[] = [];
    w.app.registerHistoryApiProvider = () => order.push("v2");
    w.app.registerHistoryProvider = () => order.push("v1");
    w.questdb.answer = (sql) => {
      if (sql.startsWith("ALTER TABLE")) order.push("retention");
      return emptyResult;
    };
    w.plugin.start(w.config);
    await waitFor(() => w.app.statuses.includes(recording(w)));
    assert.deepEqual(order, [
      "v2",
      "v1",
      "retention",
      "retention",
      "retention",
    ]);
  });

  it("reports QuestDB not responding after the deadline", async () => {
    const w = await world();
    const port = await closedPort();
    w.plugin.start({ ...w.config, questdbHttpPort: port });
    await waitFor(() => w.app.errors.length > 0);
    assert.deepEqual(w.app.errors, [
      `QuestDB not responding at 127.0.0.1:${port}`,
    ]);
    assert.deepEqual(w.app.statuses, [
      "Waiting for QuestDB to become ready...",
    ]);
    assert.equal(w.app.v2Providers.length, 0);
    assert.equal(w.app.listeners.length, 0);
  });

  it("uses an empty host verbatim", async () => {
    const w = await world();
    const port = await closedPort();
    w.plugin.start({ ...w.config, questdbHost: "", questdbHttpPort: port });
    await waitFor(() => w.app.errors.length > 0);
    assert.deepEqual(w.app.errors, [`QuestDB not responding at :${port}`]);
  });

  it("fails the start when table creation fails", async () => {
    const w = await world();
    w.questdb.answer = (sql) =>
      sql.startsWith("CREATE")
        ? { status: 500, body: "disk full" }
        : emptyResult;
    w.plugin.start(w.config);
    await waitFor(() => w.app.errors.length > 0);
    assert.deepEqual(w.app.errors, [
      "Startup failed: QuestDB query failed (500): disk full",
    ]);
    assert.equal(w.app.v2Providers.length, 0);
  });

  it("fails the start when the ILP connect is refused", async () => {
    const w = await world();
    const port = await closedPort();
    w.plugin.start({ ...w.config, questdbIlpPort: port });
    await waitFor(() => w.app.errors.length > 0);
    assert.equal(
      w.app.errors[0],
      `Startup failed: connect ECONNREFUSED 127.0.0.1:${port}`,
    );
    assert.equal(w.app.v2Providers.length, 0);
    assert.equal(w.app.listeners.length, 0);
    await waitFor(() =>
      w.app.debugLines.some((l) => l.includes("(flap #1), retrying in 2000ms")),
    );
  });

  it("fails the start when pathFilter.paths cannot be iterated", async () => {
    const w = await world();
    w.plugin.start({ ...w.config, pathFilter: { paths: 5 } });
    await waitFor(() => w.app.errors.length > 0);
    assert.ok(w.app.errors[0].startsWith("Startup failed: "));
  });

  it("logs a retention failure and keeps recording", async () => {
    const w = await world({ retentionDays: 3 });
    w.questdb.answer = (sql) =>
      sql.startsWith("ALTER TABLE signalk_str")
        ? { status: 400, body: "no ttl" }
        : emptyResult;
    w.plugin.start(w.config);
    await waitFor(() => w.app.statuses.includes(recording(w)));
    assert.deepEqual(w.app.errorLines, [
      "Could not apply the retention setting: QuestDB query failed (400): no ttl",
    ]);
    assert.deepEqual(w.app.errors, []);
    assert.equal(
      w.questdb.queries.filter((q) => q.startsWith("ALTER")).length,
      2,
    );
  });

  it("records deltas and writes buffered lines on stop", async () => {
    const w = await world();
    w.plugin.start(w.config);
    await waitFor(() => w.app.statuses.includes(recording(w)));
    w.app.emit({
      path: "navigation.speedOverGround",
      value: 6.4,
      context: w.app.selfContext,
      $source: "gps.main",
    });
    await w.plugin.stop();
    await waitFor(() =>
      w.peer.received[0].includes("navigation.speedOverGround"),
    );
    assert.ok(
      w.peer.received[0].includes(
        "signalk,path=navigation.speedOverGround,context=self,source=gps.main value=6.4",
      ),
    );
    assert.equal(w.app.listeners.length, 0);
    assert.equal(w.app.statuses.at(-1), recording(w));
  });

  it("stop during the readiness poll ends the start on the waiting line", async () => {
    const w = await world();
    const port = await closedPort();
    w.plugin.start({ ...w.config, questdbHttpPort: port });
    await waitFor(() => w.app.statuses.length === 1);
    await delay(50);
    await w.plugin.stop();
    await delay(TIMING.readinessDeadlineMs + 100);
    assert.deepEqual(w.app.statuses, [
      "Waiting for QuestDB to become ready...",
    ]);
    assert.deepEqual(w.app.errors, []);
  });

  it("stop during the final probe is not honoured", async () => {
    const w = await world();
    let release: ((reply: ScriptedAnswer) => void) | null = null;
    let probes = 0;
    w.questdb.answer = (sql) => {
      if (sql !== "SELECT 1") return emptyResult;
      probes += 1;
      if (probes !== 2) return emptyResult;
      return new Promise<ScriptedAnswer>((resolve) => {
        release = resolve;
      });
    };
    w.plugin.start(w.config);
    await waitFor(() => release !== null);
    const stopped = w.plugin.stop();
    release!(emptyResult);
    await stopped;
    await waitFor(() => w.app.errors.length > 0);
    assert.deepEqual(w.app.statuses, [
      "Waiting for QuestDB to become ready...",
      "Creating tables...",
    ]);
    assert.ok(w.app.errors[0].startsWith("Startup failed: "));
    assert.ok(w.app.errors[0].includes("null"));
    assert.equal(
      w.questdb.queries.filter((q) => q.startsWith("CREATE")).length,
      0,
    );
    assert.equal(w.app.v2Providers.length, 0);
  });

  it("a queued start cancelled by stop logs and does nothing", async () => {
    const w = await world();
    const port = await closedPort();
    w.plugin.start({ ...w.config, questdbHttpPort: port });
    await waitFor(() => w.app.statuses.length === 1);
    w.plugin.start(w.config);
    await w.plugin.stop();
    await delay(TIMING.readinessDeadlineMs + 100);
    assert.ok(
      w.app.debugLines.includes(
        "skipping queued start: plugin stopped while it waited",
      ),
    );
    assert.deepEqual(w.app.statuses, [
      "Waiting for QuestDB to become ready...",
    ]);
  });

  it("a restart runs the whole sequence again", async () => {
    const w = await world();
    w.plugin.start(w.config);
    await waitFor(() => w.app.statuses.includes(recording(w)));
    await w.plugin.stop();
    w.plugin.start(w.config);
    await waitFor(
      () => w.app.statuses.filter((s) => s === recording(w)).length === 2,
    );
    assert.equal(w.app.v2Providers.length, 2);
    assert.equal(w.app.v1Providers.length, 2);
    assert.equal(w.app.listeners.length, 1);
    assert.equal(w.peer.sockets.length, 2);
  });
});
