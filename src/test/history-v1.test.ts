// The history v1 surface: the count query, value decoding through the
// snapshot, playback window reads, vessel-name injection, and process
// lifetime, against a scripted query function.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPlaybackProvider,
  type Delta,
  type PlaybackProvider,
  type PlaybackSocket,
} from "../history/v1.js";
import { waitFor } from "./helpers.js";

const SELF = "vessels.urn:mrn:imo:mmsi:123456789";
const OTHER = "vessels.urn:mrn:imo:mmsi:244813000";

type Answer = (sql: string, index: number) => unknown[][] | Error;

interface Fixture {
  sqls: string[];
  debug: string[];
  provider: PlaybackProvider;
}

function fixture(answer: Answer = () => []): Fixture {
  const f: Fixture = {
    sqls: [],
    debug: [],
    provider: createPlaybackProvider({
      selfContext: SELF,
      debug: (m) => f.debug.push(m),
      query: async (sql) => {
        const index = f.sqls.length;
        f.sqls.push(sql);
        const reply = answer(sql, index);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }),
  };
  return f;
}

const row = (
  ts: string,
  pathName: string,
  context: string | null,
  source: string | null,
  text: unknown,
  kind: string | null,
): unknown[] => [ts, pathName, context, source, text, kind];

const T = (s: string): Date => new Date(s);

const snapshot = (f: Fixture, at = "2024-01-01T01:00:00Z"): Promise<Delta[]> =>
  new Promise((resolve) => f.provider.getHistory(T(at), "", resolve));

const isWindow = (sql: string): boolean => sql.includes("ts < '");
const isNames = (sql: string): boolean =>
  sql.includes("value_kind = 'identity'");

interface FakeSocket extends PlaybackSocket {
  written: Delta[];
  handlers: Record<string, (...args: unknown[]) => void>;
}

const fakeSocket = (write?: (delta: Delta) => void): FakeSocket => {
  const socket: FakeSocket = {
    written: [],
    handlers: {},
    write: (data) => {
      const delta = data as Delta;
      if (write) write(delta);
      socket.written.push(delta);
    },
    on: (event, callback) => {
      socket.handlers[event] = callback;
    },
  };
  return socket;
};

describe("hasAnyData", () => {
  const options = { startTime: T("2024-01-01T00:00:00Z"), playbackRate: 1 };

  it("answers true for a positive count", async () => {
    const f = fixture(() => [[7]]);
    const result = await new Promise<boolean>((resolve) =>
      f.provider.hasAnyData(options, resolve),
    );
    assert.equal(result, true);
    assert.equal(f.sqls.length, 1);
    assert.ok(f.sqls[0].includes("FROM signalk "));
    assert.ok(f.sqls[0].includes("FROM signalk_str "));
    assert.ok(f.sqls[0].includes("FROM signalk_position "));
    assert.ok(f.sqls[0].includes("ts >= '2024-01-01T00:00:00.000Z'"));
  });

  it("answers false for zero", async () => {
    const f = fixture(() => [[0]]);
    assert.equal(
      await new Promise<boolean>((r) => f.provider.hasAnyData(options, r)),
      false,
    );
  });

  it("answers false for no rows and on error", async () => {
    assert.equal(
      await new Promise<boolean>((r) =>
        fixture(() => []).provider.hasAnyData(options, r),
      ),
      false,
    );
    const f = fixture(() => new Error("boom"));
    assert.equal(
      await new Promise<boolean>((r) => f.provider.hasAnyData(options, r)),
      false,
    );
    assert.deepEqual(f.debug, []);
  });

  it("throws synchronously on an invalid date", () => {
    assert.throws(
      () =>
        fixture().provider.hasAnyData(
          { startTime: new Date(NaN), playbackRate: 1 },
          () => undefined,
        ),
      RangeError,
    );
  });
});

describe("value decoding through the snapshot", () => {
  const TS = "2024-01-01T00:00:00.000000Z";
  const value = async (r: unknown[]): Promise<unknown> => {
    const deltas = await snapshot(fixture(() => [r]));
    return deltas[0].updates[0].values[0];
  };

  it("number", async () => {
    const v = await value(
      row(TS, "navigation.speedOverGround", "self", null, "4.2", "number"),
    );
    assert.deepEqual(v, { path: "navigation.speedOverGround", value: 4.2 });
    assert.equal(typeof (v as { value: unknown }).value, "number");
  });

  it("string", async () => {
    assert.deepEqual(
      await value(
        row(TS, "navigation.state", "self", null, "anchored", "string"),
      ),
      {
        path: "navigation.state",
        value: "anchored",
      },
    );
  });

  it("boolean true", async () => {
    assert.deepEqual(
      await value(
        row(
          TS,
          "electrical.switches.bilgePump.state",
          "self",
          null,
          "true",
          "boolean",
        ),
      ),
      { path: "electrical.switches.bilgePump.state", value: true },
    );
  });

  it("untagged true stays a string", async () => {
    assert.deepEqual(
      await value(row(TS, "some.text.path", "self", null, "true", null)),
      {
        path: "some.text.path",
        value: "true",
      },
    );
  });

  it("boolean false", async () => {
    assert.deepEqual(
      await value(row(TS, "x.off", "self", null, "false", "boolean")),
      {
        path: "x.off",
        value: false,
      },
    );
  });

  it("position", async () => {
    assert.deepEqual(
      await value(
        row(
          TS,
          "navigation.position",
          "self",
          null,
          "-17.77,177.38",
          "position",
        ),
      ),
      {
        path: "navigation.position",
        value: { latitude: -17.77, longitude: 177.38 },
      },
    );
  });

  it("identity becomes an empty-path name object", async () => {
    assert.deepEqual(
      await value(row(TS, "name", OTHER, null, "Sea Breeze", "identity")),
      {
        path: "",
        value: { name: "Sea Breeze" },
      },
    );
  });

  it("a string row at path name stays data", async () => {
    const deltas = await snapshot(
      fixture(() => [
        row(TS, "name", "self", null, "not an identity", "string"),
      ]),
    );
    assert.deepEqual(deltas[0].updates[0].values, [
      { path: "name", value: "not an identity" },
    ]);
  });

  it("unparseable numbers and positions decode to null", async () => {
    const deltas = await snapshot(
      fixture(() => [
        row(TS, "x.broken", "self", null, "not-a-number", "number"),
        row(TS, "navigation.position", "self", null, "bad", "position"),
      ]),
    );
    assert.deepEqual(
      deltas[0].updates[0].values.map((v) => v.value),
      [null, null],
    );
  });

  it("null text decodes to null, and a null context is self", async () => {
    const deltas = await snapshot(
      fixture(() => [row(TS, "a.b", null, null, null, "number")]),
    );
    assert.equal(deltas[0].context, "self");
    assert.deepEqual(deltas[0].updates[0].values, [
      { path: "a.b", value: null },
    ]);
  });

  it("uses the ts text verbatim as the timestamp", async () => {
    const deltas = await snapshot(
      fixture(() => [row(TS, "a.b", "self", null, "1", "number")]),
    );
    assert.equal(deltas[0].updates[0].timestamp, TS);
  });
});

describe("missing columns and query failures", () => {
  for (const message of [
    "QuestDB query failed (400): Invalid column: value_kind",
    "QuestDB query failed (500): something else",
    "Invalid column: source",
  ]) {
    it(`reports "${message}" once and returns []`, async () => {
      const f = fixture(() => new Error(message));
      const deltas = await snapshot(f);
      assert.deepEqual(deltas, []);
      assert.equal(f.sqls.length, 1);
      assert.equal(f.debug.length, 1);
      assert.ok(f.debug[0].includes(message));
      assert.ok(f.debug[0].startsWith("getHistory error: "));
    });
  }
});

describe("snapshot query shape", () => {
  it("applies LATEST ON per branch", async () => {
    const f = fixture(() => []);
    await snapshot(f, "2024-01-01T00:00:00Z");
    const sql = f.sqls[0];
    assert.equal(sql.split("LATEST ON").length - 1, 3);
    assert.ok(sql.includes("FROM signalk_position"));
    assert.ok(sql.includes("PARTITION BY context)"));
    assert.ok(sql.includes("value_kind"));
    assert.ok(sql.includes("ts <= '2024-01-01T00:00:00.000Z'"));
    assert.ok(sql.includes("CAST(source AS STRING) source"));
  });

  it("throws synchronously on an invalid date", () => {
    assert.throws(
      () => fixture().provider.getHistory(new Date(NaN), "", () => undefined),
      RangeError,
    );
  });
});

describe("source attribution", () => {
  it("groups by source, with no $source key for null", async () => {
    const TS = "2024-01-01T00:00:00.000000Z";
    const deltas = await snapshot(
      fixture(() => [
        row(
          TS,
          "navigation.position",
          "self",
          "gps.main",
          "60.1,24.9",
          "position",
        ),
        row(
          TS,
          "navigation.position",
          "self",
          "gps.backup",
          "60.2,24.8",
          "position",
        ),
        row(TS, "environment.depth.belowKeel", "self", null, "3.2", "number"),
      ]),
    );
    assert.equal(deltas.length, 3);
    const [main, backup, depth] = deltas;
    assert.equal(main.updates[0].$source, "gps.main");
    assert.deepEqual(main.updates[0].values, [
      {
        path: "navigation.position",
        value: { latitude: 60.1, longitude: 24.9 },
      },
    ]);
    assert.equal(backup.updates[0].$source, "gps.backup");
    assert.deepEqual(backup.updates[0].values, [
      {
        path: "navigation.position",
        value: { latitude: 60.2, longitude: 24.8 },
      },
    ]);
    assert.deepEqual(depth.updates[0].values, [
      { path: "environment.depth.belowKeel", value: 3.2 },
    ]);
    assert.ok(!("$source" in depth.updates[0]));
  });
});

describe("playback window reads", () => {
  const START = T("2024-01-01T00:00:00Z");
  const page = (stamps: (index: number) => string): unknown[][] =>
    Array.from({ length: 10000 }, (_, i) =>
      row(stamps(i), "a.b", "self", null, "1", "number"),
    );

  async function secondRead(
    first: unknown[][],
    playbackRate = 1,
  ): Promise<{ f: Fixture; second: string; elapsed: number }> {
    const started = Date.now();
    let secondAt = 0;
    const f = fixture((sql, index) => {
      if (isNames(sql)) return [];
      if (index === 0) return first;
      if (secondAt === 0) secondAt = Date.now();
      return [];
    });
    const stop = f.provider.streamHistory(
      fakeSocket(),
      { startTime: START, playbackRate },
      () => undefined,
    );
    await waitFor(() => f.sqls.filter(isWindow).length >= 2, 100000);
    stop();
    return {
      f,
      second: f.sqls.filter(isWindow)[1],
      elapsed: secondAt - started,
    };
  }

  it("resumes at the last row of a full page", async () => {
    const { second } = await secondRead(
      page((i) =>
        i === 9999
          ? "2024-01-01T00:00:30.000000Z"
          : "2024-01-01T00:00:00.000000Z",
      ),
    );
    assert.ok(second.includes("ts >= '2024-01-01T00:00:30.000"));
  });

  it("re-reads a tied millisecond", async () => {
    const { second } = await secondRead(
      page((i) =>
        i === 0 ? "2024-01-01T00:00:05.000000Z" : "2024-01-01T00:00:10.000000Z",
      ),
    );
    assert.ok(second.includes("ts >= '2024-01-01T00:00:10.000"));
  });

  it("steps one millisecond past a page that shares the cursor", async () => {
    const { second } = await secondRead(
      page(() => "2024-01-01T00:00:00.000000Z"),
    );
    assert.ok(second.includes("ts >= '2024-01-01T00:00:00.001"));
  });

  it("paces the next window by the playback rate", async () => {
    const { second, elapsed } = await secondRead(
      [row("2024-01-01T00:00:05.000000Z", "a.b", "self", null, "1", "number")],
      6000,
    );
    assert.ok(second.includes("ts >= '2024-01-01T00:01:00.000"));
    assert.ok(elapsed >= 5 && elapsed < 2000, `elapsed ${elapsed}`);
  });

  it("reads the first window during the call with a 60 s window", async () => {
    const f = fixture(() => []);
    const stop = f.provider.streamHistory(
      fakeSocket(),
      { startTime: START, playbackRate: 1 },
      () => undefined,
    );
    assert.equal(f.sqls.length, 1);
    assert.ok(
      f.sqls[0].includes(
        "ts >= '2024-01-01T00:00:00.000Z' AND ts < '2024-01-01T00:01:00.000Z'",
      ),
    );
    assert.ok(f.sqls[0].endsWith("ORDER BY ts LIMIT 10000"));
    stop();
  });

  it("polls empty windows every 100 ms", async () => {
    const f = fixture(() => []);
    const stop = f.provider.streamHistory(
      fakeSocket(),
      { startTime: START, playbackRate: 1 },
      () => undefined,
    );
    await waitFor(() => f.sqls.length >= 3, 100000);
    stop();
    assert.ok(f.sqls[2].includes("ts >= '2024-01-01T00:02:00.000Z'"));
  });

  it("retries the same window after a failure and logs it", async () => {
    const f = fixture(
      () => new Error("QuestDB query failed (400): Invalid column: value_kind"),
    );
    const stop = f.provider.streamHistory(
      fakeSocket(),
      { startTime: START, playbackRate: 1 },
      () => undefined,
    );
    await waitFor(() => f.sqls.length >= 2, 100000);
    stop();
    assert.equal(f.sqls[0], f.sqls[1]);
    assert.ok(f.debug[0].startsWith("streamHistory error: "));
    assert.ok(f.debug[0].includes("Invalid column: value_kind"));
  });

  it("treats a throwing socket write as a read error", async () => {
    let throws = true;
    const f = fixture((sql) =>
      isNames(sql)
        ? []
        : [
            row(
              "2024-01-01T00:00:05.000000Z",
              "a.b",
              "self",
              null,
              "1",
              "number",
            ),
          ],
    );
    const socket = fakeSocket(() => {
      if (throws) {
        throws = false;
        throw new Error("socket closed");
      }
    });
    const stop = f.provider.streamHistory(
      socket,
      { startTime: START, playbackRate: 1 },
      () => undefined,
    );
    await waitFor(() => socket.written.length >= 1, 100000);
    stop();
    assert.deepEqual(f.debug, ["streamHistory error: socket closed"]);
    assert.equal(f.sqls.filter(isWindow).length, 2);
    assert.equal(f.sqls.filter(isWindow)[0], f.sqls.filter(isWindow)[1]);
    assert.equal(f.sqls.filter(isNames).length, 1);
  });

  it("the socket end event stops the stream", async () => {
    const f = fixture(() => []);
    const socket = fakeSocket();
    f.provider.streamHistory(
      socket,
      { startTime: START, playbackRate: 1 },
      () => undefined,
    );
    socket.handlers.end();
    const before = f.sqls.length;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(f.sqls.length, before);
  });

  it("throws synchronously on an invalid start time", () => {
    assert.throws(
      () =>
        fixture().provider.streamHistory(
          fakeSocket(),
          { startTime: new Date(NaN), playbackRate: 1 },
          () => undefined,
        ),
      RangeError,
    );
  });
});

describe("vessel-name injection", () => {
  const START = T("2024-01-01T00:00:00Z");
  const TS = "2024-01-01T00:00:05.000000Z";

  async function play(
    windowRows: unknown[][],
    names: unknown[][] | Error,
    writes: number,
  ): Promise<{ f: Fixture; socket: FakeSocket }> {
    const f = fixture((sql, index) => {
      if (isNames(sql)) return names;
      return index === 0 ? windowRows : [];
    });
    const socket = fakeSocket();
    const stop = f.provider.streamHistory(
      socket,
      { startTime: START, playbackRate: 1 },
      () => undefined,
    );
    await waitFor(() => socket.written.length >= writes, 100000);
    stop();
    return { f, socket };
  }

  it("injects a name once per context before its first delta", async () => {
    const { f, socket } = await play(
      [
        row(TS, "navigation.speedOverGround", OTHER, null, "1", "number"),
        row(
          "2024-01-01T00:00:06.000000Z",
          "navigation.speedOverGround",
          OTHER,
          null,
          "2",
          "number",
        ),
      ],
      [[OTHER, "Sea Breeze"]],
      3,
    );
    assert.equal(socket.written[0].context, OTHER);
    assert.deepEqual(socket.written[0].updates[0].values, [
      { path: "", value: { name: "Sea Breeze" } },
    ]);
    assert.equal(socket.written[0].updates[0].timestamp, TS);
    assert.ok(!("$source" in socket.written[0].updates[0]));
    assert.equal(
      socket.written.filter((d) =>
        d.updates[0].values.some((v) => v.path === ""),
      ).length,
      1,
    );
    const lookups = f.sqls.filter(isNames);
    assert.equal(lookups.length, 1);
    assert.ok(lookups[0].includes("ts <= '2024-01-01T00:00:00"));
    assert.ok(lookups[0].includes("value_kind = 'identity'"));
    assert.ok(lookups[0].includes("LATEST ON ts PARTITION BY context"));
  });

  it("maps self to the server context on playback", async () => {
    const { socket } = await play(
      [row(TS, "navigation.speedOverGround", "self", null, "1", "number")],
      [["self", "Vessel Aurora"]],
      2,
    );
    assert.equal(socket.written[0].context, SELF);
    assert.deepEqual(socket.written[0].updates[0].values[0], {
      path: "",
      value: { name: "Vessel Aurora" },
    });
    assert.equal(socket.written[1].context, SELF);
  });

  it("plays unlabeled when the lookup fails", async () => {
    const { f, socket } = await play(
      [row(TS, "navigation.speedOverGround", OTHER, null, "1", "number")],
      new Error("QuestDB query failed (500): boom"),
      1,
    );
    assert.equal(socket.written[0].context, OTHER);
    assert.ok(
      socket.written.every((d) =>
        d.updates[0].values.every((v) => v.path !== ""),
      ),
    );
    assert.deepEqual(f.debug, []);
  });

  it("ignores an empty name", async () => {
    const { socket } = await play(
      [row(TS, "navigation.speedOverGround", OTHER, null, "1", "number")],
      [[OTHER, ""]],
      1,
    );
    assert.equal(socket.written.length, 1);
    assert.equal(
      socket.written[0].updates[0].values[0].path,
      "navigation.speedOverGround",
    );
  });
});

describe("process lifetime", () => {
  it("a playback with no stop does not keep the process alive", async () => {
    const module = pathToFileURL(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../history/v1.js",
      ),
    ).href;
    const script = `
      const { createPlaybackProvider } = await import(${JSON.stringify(module)});
      const provider = createPlaybackProvider({
        selfContext: "vessels.self",
        debug: () => {},
        query: async (sql) => sql.includes("identity") ? [] :
          [["2024-01-01T00:00:00.000000Z", "a.b", "self", null, "1", "number"]],
      });
      provider.streamHistory({ write() {}, on() {} }, { startTime: new Date("2024-01-01T00:00:00Z"), playbackRate: 1 }, () => {});
    `;
    const started = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 10000 },
        (error, _stdout, stderr) => {
          if (error && error.killed)
            reject(new Error(`process still alive: ${stderr}`));
          else resolve(error ? (error.code as number) : 0);
        },
      );
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 10000);
  });
});
