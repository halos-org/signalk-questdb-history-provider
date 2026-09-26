// The history v2 surface: time range resolution, the bucket guard, context
// handling, the query families, the string fallback, and the client-side
// aggregates, against a scripted query function.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Temporal } from "@js-temporal/polyfill";
import type { history } from "@signalk/server-api";
import {
  EMA_DEFAULT_ALPHA,
  SMA_DEFAULT_WINDOW,
  createHistoryApiProvider,
} from "../history/v2.js";

const SELF = "vessels.urn:mrn:imo:mmsi:123456789";
const I = (s: string): Temporal.Instant => Temporal.Instant.from(s);
const D = (s: string): Temporal.Duration => Temporal.Duration.from(s);

type Answer = (sql: string) => unknown[][] | Error;

interface Fixture {
  sqls: string[];
  provider: history.HistoryProvider;
}

function fixture(answer: Answer = () => [], selfContext = SELF): Fixture {
  const sqls: string[] = [];
  return {
    sqls,
    provider: createHistoryApiProvider({
      selfContext,
      query: async (sql) => {
        sqls.push(sql);
        const reply = answer(sql);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }),
  };
}

const spec = (over: Record<string, unknown> = {}): history.PathSpec =>
  ({
    path: "navigation.speedOverGround",
    aggregate: "average",
    parameter: [],
    ...over,
  }) as unknown as history.PathSpec;

const request = (over: Record<string, unknown> = {}): history.ValuesRequest =>
  ({
    from: I("2024-01-01T00:00:00Z"),
    to: I("2024-01-01T01:00:00Z"),
    pathSpecs: [spec()],
    ...over,
  }) as unknown as history.ValuesRequest;

const NOW_TOLERANCE_MS = 5000;
const withinNow = (iso: string): boolean =>
  Date.now() - Date.parse(iso) < NOW_TOLERANCE_MS &&
  Date.now() - Date.parse(iso) >= 0;

describe("time range resolution", () => {
  it("from and to", async () => {
    const f = fixture();
    const r = await f.provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: I("2024-01-02T00:00:00Z"),
      }),
    );
    assert.deepEqual(r.range, {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
    });
  });

  it("from and duration", async () => {
    const r = await fixture().provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: undefined,
        duration: D("PT1H"),
      }),
    );
    assert.deepEqual(r.range, {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-01T01:00:00Z",
    });
  });

  it("to and duration", async () => {
    const r = await fixture().provider.getValues(
      request({
        from: undefined,
        to: I("2024-01-02T00:00:00Z"),
        duration: D("PT1H"),
      }),
    );
    assert.deepEqual(r.range, {
      from: "2024-01-01T23:00:00Z",
      to: "2024-01-02T00:00:00Z",
    });
  });

  it("from only ends now", async () => {
    const r = await fixture().provider.getValues(
      request({ from: I("2024-01-01T00:00:00Z"), to: undefined }),
    );
    assert.equal(r.range.from, "2024-01-01T00:00:00Z");
    assert.ok(withinNow(r.range.to));
  });

  it("duration only ends now", async () => {
    const r = await fixture().provider.getValues(
      request({ from: undefined, to: undefined, duration: D("PT30M") }),
    );
    const span = Date.parse(r.range.to) - Date.parse(r.range.from);
    assert.ok(Math.abs(span - 30 * 60 * 1000) < NOW_TOLERANCE_MS);
    assert.ok(withinNow(r.range.to));
  });

  it("numeric duration in seconds", async () => {
    const r = await fixture().provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: undefined,
        duration: 3600,
      }),
    );
    assert.equal(r.range.to, "2024-01-01T01:00:00Z");
  });

  it("nothing at all rejects", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(request({ from: undefined, to: undefined })),
      {
        name: "Error",
        message: "Invalid time range: provide at least from or duration",
      },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("to alone rejects", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({ from: undefined, to: I("2024-01-02T00:00:00Z") }),
      ),
      { message: "Invalid time range: provide at least from or duration" },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("from and to ignore a duration", async () => {
    const r = await fixture().provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: I("2024-01-02T00:00:00Z"),
        duration: D("PT1H"),
      }),
    );
    assert.deepEqual(r.range, {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
    });
  });

  it("emits an offset instant in UTC", async () => {
    const r = await fixture().provider.getValues(
      request({
        from: I("2024-01-01T02:00:00+02:00"),
        to: I("2024-01-02T00:00:00Z"),
      }),
    );
    assert.equal(r.range.from, "2024-01-01T00:00:00Z");
  });

  it("resolves fractional seconds exactly and floors the predicate", async () => {
    const f = fixture();
    const r = await f.provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: undefined,
        duration: D("PT1.5S"),
      }),
    );
    assert.equal(r.range.to, "2024-01-01T00:00:01.5Z");
    assert.ok(f.sqls[0].includes("ts <= '2024-01-01T00:00:01.500Z'"));
  });

  it("echoes nanoseconds in the range and floors the predicate", async () => {
    const f = fixture();
    const r = await f.provider.getValues(
      request({
        from: I("2024-01-01T00:00:00.123456789Z"),
        to: I("2024-01-02T00:00:00Z"),
      }),
    );
    assert.equal(r.range.from, "2024-01-01T00:00:00.123456789Z");
    assert.ok(f.sqls[0].includes("ts >= '2024-01-01T00:00:00.123Z'"));
  });

  it("PT0S gives an empty range at from", async () => {
    const r = await fixture().provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: undefined,
        duration: D("PT0S"),
      }),
    );
    assert.deepEqual(r.range, {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-01T00:00:00Z",
    });
  });

  it("numeric 0 with from counts as absent", async () => {
    const r = await fixture().provider.getValues(
      request({ from: I("2024-01-01T00:00:00Z"), to: undefined, duration: 0 }),
    );
    assert.equal(r.range.from, "2024-01-01T00:00:00Z");
    assert.ok(withinNow(r.range.to));
  });

  it("numeric 0 alone rejects", async () => {
    await assert.rejects(
      fixture().provider.getValues(
        request({ from: undefined, to: undefined, duration: 0 }),
      ),
      { message: "Invalid time range: provide at least from or duration" },
    );
  });

  it("a calendar duration rejects with the Temporal RangeError", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({
          from: I("2024-01-01T00:00:00Z"),
          to: undefined,
          duration: D("P1D"),
        }),
      ),
      {
        name: "RangeError",
        message:
          "Duration field day not supported by Temporal.Instant. Try Temporal.ZonedDateTime instead.",
      },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("a negative duration inverts the range without error", async () => {
    const f = fixture();
    const r = await f.provider.getValues(
      request({
        from: I("2024-01-01T00:00:00Z"),
        to: undefined,
        duration: D("-PT1H"),
      }),
    );
    assert.deepEqual(r.range, {
      from: "2024-01-01T00:00:00Z",
      to: "2023-12-31T23:00:00Z",
    });
    assert.ok(
      f.sqls.every((s) =>
        s.includes(
          "ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2023-12-31T23:00:00.000Z'",
        ),
      ),
    );
    assert.ok(f.sqls.length > 0);
  });

  it("a fractional numeric duration rejects", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({
          from: I("2024-01-01T00:00:00Z"),
          to: undefined,
          duration: 1.5,
        }),
      ),
      { name: "RangeError", message: "unsupported fractional value 1.5" },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("a NaN duration rejects", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({
          from: I("2024-01-01T00:00:00Z"),
          to: undefined,
          duration: NaN,
        }),
      ),
      { name: "RangeError", message: "not a number" },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("no path specs issues no SQL", async () => {
    const f = fixture();
    const r = await f.provider.getValues(request({ pathSpecs: [] }));
    assert.deepEqual(r, {
      context: "vessels.self",
      range: { from: "2024-01-01T00:00:00Z", to: "2024-01-01T01:00:00Z" },
      values: [],
      data: [],
    });
    assert.deepEqual(f.sqls, []);
  });

  it("an empty context rejects even with no path specs", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(request({ pathSpecs: [], context: "" })),
      {
        message: "Invalid identifier: ",
      },
    );
    assert.deepEqual(f.sqls, []);
  });

  const notDates = {
    from: { toString: () => "not-a-date" },
    to: { toString: () => "nor-this" },
  };

  it("an unparseable bound rejects in getValues after the guard", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(request({ ...notDates, resolution: 1 })),
      (e) => {
        assert.ok(e instanceof Error);
        assert.equal(e.message, "Invalid timestamp: not-a-date");
        return true;
      },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("an unparseable bound rejects in getPaths", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getPaths(notDates as unknown as history.PathsRequest),
      { message: "Invalid timestamp: not-a-date" },
    );
    assert.deepEqual(f.sqls, []);
  });
});

describe("context handling", () => {
  for (const [context, stored] of [
    ["vessels.self", "self"],
    [SELF, "self"],
    ["self", "self"],
    [
      "vessels.urn:mrn:imo:mmsi:987654321",
      "vessels.urn:mrn:imo:mmsi:987654321",
    ],
  ]) {
    it(`maps ${context} to ${stored}`, async () => {
      const f = fixture();
      const r = await f.provider.getValues(request({ context }));
      assert.ok(f.sqls[0].includes(`context = '${stored}'`));
      assert.equal(r.context, context);
    });
  }

  it("defaults to vessels.self", async () => {
    const f = fixture();
    const r = await f.provider.getValues(request());
    assert.equal(r.context, "vessels.self");
    assert.ok(f.sqls[0].includes("context = 'self'"));
  });

  it("rejects an unsafe context", async () => {
    await assert.rejects(
      fixture().provider.getValues(request({ context: "x'; DROP" })),
      {
        message: "Invalid identifier: x'; DROP",
      },
    );
  });
});

describe("position path", () => {
  const position = (aggregate: string): history.ValuesRequest =>
    request({
      resolution: 60,
      pathSpecs: [
        spec({
          path: "navigation.position",
          aggregate,
        }),
      ],
    });

  it("uses first for first", async () => {
    const f = fixture();
    await f.provider.getValues(position("first"));
    assert.ok(
      f.sqls[0].includes("first(lat)") && f.sqls[0].includes("first(lon)"),
    );
  });

  it("uses last for last", async () => {
    const f = fixture();
    await f.provider.getValues(position("last"));
    assert.ok(
      f.sqls[0].includes("last(lat)") && f.sqls[0].includes("last(lon)"),
    );
  });

  for (const aggregate of ["average", "min", "max", "mid", "middle_index"]) {
    it(`uses first for ${aggregate} and reports the requested method`, async () => {
      const f = fixture();
      const r = await f.provider.getValues(position(aggregate));
      assert.ok(
        f.sqls[0].includes("first(lat)") && f.sqls[0].includes("first(lon)"),
      );
      assert.equal(f.sqls.length, 1);
      assert.equal(r.values[0].method, aggregate);
    });
  }

  it("decodes rows into position objects and nulls", async () => {
    const f = fixture(() => [
      ["2024-01-01T00:00:00.000000Z", 60.1, 24.9],
      ["2024-01-01T00:01:00.000000Z", null, null],
    ]);
    const r = await f.provider.getValues(position("first"));
    assert.deepEqual(r.data, [
      ["2024-01-01T00:00:00.000000Z", { latitude: 60.1, longitude: 24.9 }],
      ["2024-01-01T00:01:00.000000Z", null],
    ]);
  });
});

describe("sample bucket guard", () => {
  const twoMonths = {
    from: I("2024-01-01T00:00:00Z"),
    to: I("2024-03-01T00:00:00Z"),
  };
  const oneWeek = {
    from: I("2024-01-01T00:00:00Z"),
    to: I("2024-01-08T00:00:00Z"),
  };
  const positionFirst = spec({
    path: "navigation.position",
    aggregate: "first",
  });

  it("rejects one position spec at 1 s over two months", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({ ...twoMonths, resolution: 1, pathSpecs: [positionFirst] }),
      ),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes("sample buckets"));
        assert.ok(
          e.message.startsWith("resolution 1s over this range produces up to "),
        );
        assert.ok(
          e.message.includes(
            " across 1 paths (max 1000000) — use a coarser resolution or a shorter range",
          ),
        );
        return true;
      },
    );
    assert.deepEqual(f.sqls, []);
  });

  it("accepts the same range at 2600 s", async () => {
    const f = fixture();
    await f.provider.getValues(
      request({ ...twoMonths, resolution: 2600, pathSpecs: [positionFirst] }),
    );
    assert.equal(f.sqls.length, 1);
    assert.ok(f.sqls[0].includes("SAMPLE BY 2600s"));
  });

  it("rounds a sub-second resolution up to 1 s", async () => {
    const f = fixture();
    await f.provider.getValues(request({ resolution: 0.5 }));
    assert.ok(f.sqls.some((s) => s.includes("signalk_str")));
    assert.ok(
      f.sqls
        .filter((s) => s.includes("SAMPLE BY"))
        .every((s) => s.includes("SAMPLE BY 1s")),
    );
    assert.ok(f.sqls.every((s) => !s.includes("SAMPLE BY 0s")));
  });

  it("rejects a position and a numeric spec at 1 s over a week", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({
          ...oneWeek,
          resolution: 1,
          pathSpecs: [positionFirst, spec()],
        }),
      ),
      /sample buckets/,
    );
    assert.deepEqual(f.sqls, []);
  });

  it("rejects one fallback-capable spec at 1 s over a week", async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.getValues(
        request({
          ...oneWeek,
          resolution: 1,
          pathSpecs: [
            spec({
              path: "electrical.switches.bilgePump.state",
              aggregate: "first",
            }),
          ],
        }),
      ),
      /sample buckets/,
    );
    assert.deepEqual(f.sqls, []);
  });

  it("accepts one position spec at 1 s over a week", async () => {
    const f = fixture();
    await f.provider.getValues(
      request({ ...oneWeek, resolution: 1, pathSpecs: [positionFirst] }),
    );
    assert.ok(f.sqls.length >= 1);
  });

  for (const [aggregate, parameter] of [
    ["sma", ["5"]],
    ["ema", ["0.2"]],
    ["middle_index", []],
  ] as const) {
    it(`never counts ${aggregate} and reads raw rows`, async () => {
      const f = fixture();
      await f.provider.getValues(
        request({
          ...twoMonths,
          resolution: 1,
          pathSpecs: [spec({ aggregate, parameter: [...parameter] })],
        }),
      );
      assert.equal(f.sqls.length, 3);
      assert.ok(f.sqls[0].includes("LIMIT 50000"));
      assert.ok(
        f.sqls[1].includes("FROM signalk_str") && f.sqls[1].endsWith("LIMIT 1"),
      );
      assert.ok(f.sqls[2].includes("SELECT DISTINCT path, 'signalk' tbl"));
      assert.ok(f.sqls.every((s) => !s.includes("SAMPLE BY")));
    });
  }
});

describe("string-table fallback", () => {
  const TS = "2024-01-01T00:00:01.000000Z";
  const self = (
    over: Record<string, unknown>,
    pathOver: Record<string, unknown>,
  ) =>
    request({
      context: "self",
      pathSpecs: [spec({ aggregate: "first", ...pathOver })],
      ...over,
    });

  it("falls back to the string table", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "true"]] : [],
    );
    const r = await f.provider.getValues(
      self({}, { path: "watermaker.brineomatic.high_pressure_pump_on" }),
    );
    assert.deepEqual(r.data, [[TS, "true"]]);
    assert.ok(f.sqls.some((s) => s.includes("signalk_str")));
  });

  it("issues no string-table query while numeric rows are present", async () => {
    const f = fixture(() => [[TS, 4.2]]);
    const r = await f.provider.getValues(
      self({}, { path: "environment.depth.belowKeel" }),
    );
    assert.deepEqual(r.data, [[TS, 4.2]]);
    assert.ok(f.sqls.every((s) => !s.includes("signalk_str")));
  });

  it("treats all-null buckets as empty", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str")
        ? [["2024-01-01T00:00:00.000000Z", "false"]]
        : [
            ["2024-01-01T00:00:00.000000Z", null],
            ["2024-01-01T00:10:00.000000Z", null],
          ],
    );
    const r = await f.provider.getValues(
      self(
        { resolution: 600 },
        { path: "electrical.switches.bilgePump.state" },
      ),
    );
    assert.deepEqual(r.data, [["2024-01-01T00:00:00.000000Z", "false"]]);
  });

  it("reports last when downsampled and falling back", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "on"]] : [],
    );
    const r = await f.provider.getValues(
      self(
        { resolution: 600 },
        { path: "navigation.state", aggregate: "average" },
      ),
    );
    assert.equal(r.values[0].method, "last");
  });

  it("keeps the requested method when raw", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "on"]] : [],
    );
    const r = await f.provider.getValues(
      self({}, { path: "navigation.state" }),
    );
    assert.equal(r.values[0].method, "first");
  });

  it("decodes a tagged boolean", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "true", "boolean"]] : [],
    );
    const r = await f.provider.getValues(
      self({}, { path: "electrical.switches.bilgePump.state" }),
    );
    assert.equal(r.data[0][1], true);
  });

  it("keeps an untagged true as a string", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "true", null]] : [],
    );
    const r = await f.provider.getValues(
      self({}, { path: "navigation.state" }),
    );
    assert.equal(r.data[0][1], "true");
  });

  it("propagates a string query failure after one attempt", async () => {
    const f = fixture((sql) =>
      sql.includes("value_kind")
        ? new Error("QuestDB query failed (400): Invalid column: value_kind")
        : [],
    );
    await assert.rejects(
      f.provider.getValues(self({}, { path: "some.path" })),
      {
        message: "QuestDB query failed (400): Invalid column: value_kind",
      },
    );
    assert.equal(f.sqls.filter((s) => s.includes("signalk_str")).length, 1);
  });

  it("uses last() in the downsampled string query", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "on"]] : [],
    );
    await f.provider.getValues(
      self({ resolution: 600 }, { path: "navigation.state" }),
    );
    const stringSql = f.sqls.find((s) => s.includes("signalk_str"))!;
    assert.ok(stringSql.includes("last(value_str)"));
    assert.ok(!stringSql.includes("avg("));
  });
});

describe("path and context discovery", () => {
  const range = {
    from: I("2024-01-01T00:00:00Z"),
    to: I("2024-01-01T01:00:00Z"),
  } as unknown as history.PathsRequest;

  it("getPaths unions the three tables", async () => {
    const f = fixture(() => [["a.b"], ["navigation.position"]]);
    const paths = await f.provider.getPaths(range);
    assert.equal(f.sqls.length, 1);
    assert.ok(f.sqls[0].includes("signalk_position"));
    assert.ok(f.sqls[0].includes("'navigation.position'"));
    assert.ok(!f.sqls[0].includes("context ="));
    assert.deepEqual(paths, ["a.b", "navigation.position"]);
  });

  it("getContexts unions the three tables and maps self", async () => {
    const f = fixture(() => [["self"], ["vessels.urn:mrn:imo:mmsi:1"]]);
    const contexts = await f.provider.getContexts(range);
    assert.equal(f.sqls.length, 1);
    assert.ok(f.sqls[0].includes("signalk_position"));
    assert.deepEqual(contexts, ["vessels.self", "vessels.urn:mrn:imo:mmsi:1"]);
  });
});

describe("sourceRef filtering", () => {
  const TS = "2024-01-01T00:00:01.000000Z";
  const withContext = (specs: history.PathSpec[]): history.ValuesRequest =>
    request({ context: "self", pathSpecs: specs });

  it("adds the source clause", async () => {
    const f = fixture(() => [[TS, 4.2]]);
    await f.provider.getValues(
      withContext([
        spec({
          sourceRef: "n2k-on-ve.can0.115",
        }),
      ]),
    );
    assert.ok(f.sqls[0].includes("AND source = 'n2k-on-ve.can0.115'"));
  });

  it("omits the clause without a sourceRef", async () => {
    const f = fixture(() => [[TS, 4.2]]);
    await f.provider.getValues(withContext([spec()]));
    assert.ok(!f.sqls[0].includes("source ="));
  });

  it("filters the position table", async () => {
    const f = fixture(() => [[TS, 60.1, 24.9]]);
    await f.provider.getValues(
      withContext([
        spec({
          path: "navigation.position",
          aggregate: "first",
          sourceRef: "gps.main",
        }),
      ]),
    );
    assert.ok(f.sqls[0].includes("signalk_position"));
    assert.ok(f.sqls[0].includes("AND source = 'gps.main'"));
  });

  it("filters the string fallback", async () => {
    const f = fixture((sql) =>
      sql.includes("signalk_str") ? [[TS, "true"]] : [],
    );
    await f.provider.getValues(
      withContext([
        spec({
          path: "switches.bilge.state",
          aggregate: "first",
          sourceRef: "n2k-on-ve.can0.42",
        }),
      ]),
    );
    const stringSql = f.sqls.find((s) => s.includes("signalk_str"))!;
    assert.ok(stringSql.includes("AND source = 'n2k-on-ve.can0.42'"));
  });

  it("reports sourceRef only where given", async () => {
    const f = fixture(() => [[TS, 4.2]]);
    const r = await f.provider.getValues(
      withContext([spec({ sourceRef: "gps.main" }), spec()]),
    );
    assert.equal(r.values[0].$source, "gps.main");
    assert.ok(!("$source" in r.values[1]));
  });

  it("gives one column per source", async () => {
    const f = fixture((sql) => [[TS, sql.includes("gps.main") ? 1.1 : 2.2]]);
    const r = await f.provider.getValues(
      withContext([
        spec({ sourceRef: "gps.main" }),
        spec({ sourceRef: "gps.backup" }),
      ]),
    );
    assert.deepEqual(r.data, [[TS, 1.1, 2.2]]);
  });

  it("rejects an unsafe sourceRef", async () => {
    await assert.rejects(
      fixture().provider.getValues(
        withContext([
          spec({
            sourceRef: "x'; DROP TABLE signalk",
          }),
        ]),
      ),
      /Invalid identifier/,
    );
  });

  it("validates the second spec only after the first query ran", async () => {
    const f = fixture(() => []);
    await assert.rejects(
      f.provider.getValues(withContext([spec(), spec({ path: "bad path" })])),
      { message: "Invalid identifier: bad path" },
    );
    assert.ok(f.sqls.length >= 1);
  });
});

describe("source policy", () => {
  const TS = "2024-01-01T00:00:01.000000Z";
  const P = "navigation.speedOverGround";
  const Q18 =
    "SELECT DISTINCT path, source FROM signalk WHERE ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2024-01-01T01:00:00.000Z' AND context = 'self' UNION SELECT DISTINCT path, source FROM signalk_str WHERE ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2024-01-01T01:00:00.000Z' AND context = 'self'";
  const isQ18 = (sql: string): boolean =>
    sql.startsWith("SELECT DISTINCT path, source");
  const isQ19 = (sql: string): boolean =>
    sql.startsWith("SELECT DISTINCT source FROM signalk_position");
  const all = (
    specs: history.PathSpec[],
    over: Record<string, unknown> = {},
  ): history.ValuesRequest =>
    request({
      context: "self",
      sourcePolicy: "all",
      pathSpecs: specs,
      ...over,
    });

  it("issues no discovery without the policy", async () => {
    const f = fixture(() => [[TS, 4.2]]);
    const r = await f.provider.getValues(
      request({ context: "self", pathSpecs: [spec()] }),
    );
    assert.ok(!f.sqls.some(isQ18));
    assert.equal(r.values.length, 1);
  });

  it("treats another policy value as absent", async () => {
    const f = fixture(() => [[TS, 4.2]]);
    await f.provider.getValues(all([spec()], { sourcePolicy: "preferred" }));
    assert.ok(!f.sqls.some(isQ18));
  });

  it("splits a path into one column per source, ordered by source", async () => {
    const f = fixture((sql) => {
      if (isQ18(sql))
        return [
          [P, "gps.main"],
          [P, "gps.backup"],
          ["other.path", "x"],
        ];
      return [[TS, sql.includes("'gps.main'") ? 1.1 : 2.2]];
    });
    const r = await f.provider.getValues(all([spec()]));
    assert.equal(f.sqls[0], Q18);
    assert.deepEqual(r.values, [
      { path: P, method: "average", $source: "gps.backup" },
      { path: P, method: "average", $source: "gps.main" },
    ]);
    assert.deepEqual(r.data, [[TS, 2.2, 1.1]]);
  });

  it("issues discovery once per request", async () => {
    const f = fixture((sql) => (isQ18(sql) ? [[P, "a"]] : [[TS, 1]]));
    await f.provider.getValues(all([spec(), spec({ aggregate: "max" })]));
    assert.equal(f.sqls.filter(isQ18).length, 1);
  });

  it("keeps a specification with a sourceRef as a filter", async () => {
    const f = fixture((sql) =>
      isQ18(sql)
        ? [
            [P, "gps.main"],
            [P, "gps.backup"],
          ]
        : [[TS, 1]],
    );
    const r = await f.provider.getValues(
      all([spec({ sourceRef: "gps.main" }), spec()]),
    );
    assert.deepEqual(
      r.values.map((v) => v.$source),
      ["gps.main", "gps.backup", "gps.main"],
    );
  });

  it("gives rows without a source their own unlabelled column", async () => {
    const f = fixture((sql) =>
      isQ18(sql)
        ? [
            [P, null],
            [P, "gps.main"],
          ]
        : [[TS, 1]],
    );
    const r = await f.provider.getValues(all([spec()]));
    assert.equal(r.values.length, 2);
    assert.equal(r.values[0].$source, "gps.main");
    assert.ok(!("$source" in r.values[1]));
    const reads = f.sqls.filter((sql) => !isQ18(sql));
    assert.ok(reads[reads.length - 1].includes("AND source IS NULL"));
  });

  it("quotes a stored source rather than validating it", async () => {
    const f = fixture((sql) => (isQ18(sql) ? [[P, "My GPS's"]] : [[TS, 1]]));
    const r = await f.provider.getValues(all([spec()]));
    assert.ok(f.sqls[1].includes("AND source = 'My GPS''s'"));
    assert.equal(r.values[0].$source, "My GPS's");
  });

  it("drops a path with no rows", async () => {
    const f = fixture((sql) => (isQ18(sql) ? [["other.path", "x"]] : []));
    const r = await f.provider.getValues(all([spec()]));
    assert.deepEqual(r.values, []);
    assert.deepEqual(r.data, []);
    assert.equal(f.sqls.length, 1);
  });

  it("splits an object path by the sources of its leaves", async () => {
    const f = fixture((sql) => {
      if (isQ18(sql))
        return [
          ["navigation.attitude#/roll", "a"],
          ["navigation.attitude#/pitch", "b"],
        ];
      if (sql.startsWith("SELECT DISTINCT path, 'signalk' tbl"))
        return [
          ["navigation.attitude#/roll", "signalk"],
          ["navigation.attitude#/pitch", "signalk"],
        ];
      return [];
    });
    const r = await f.provider.getValues(
      all([spec({ path: "navigation.attitude", aggregate: "last" })], {
        resolution: 60,
      }),
    );
    assert.deepEqual(
      r.values.map((v) => v.$source),
      ["a", "b"],
    );
    const leafReads = f.sqls.filter((sql) => sql.includes("arrival"));
    assert.ok(leafReads.some((sql) => sql.includes("AND source = 'a'")));
    assert.ok(leafReads.some((sql) => sql.includes("AND source = 'b'")));
  });

  it("splits the position path from its own table", async () => {
    const f = fixture((sql) =>
      isQ19(sql) ? [["gps.b"], ["gps.a"]] : [[TS, 60.1, 24.9]],
    );
    const r = await f.provider.getValues(
      all([spec({ path: "navigation.position", aggregate: "first" })]),
    );
    assert.ok(!f.sqls.some(isQ18));
    assert.equal(f.sqls.filter(isQ19).length, 1);
    assert.deepEqual(
      r.values.map((v) => v.$source),
      ["gps.a", "gps.b"],
    );
    assert.ok(f.sqls[1].includes("signalk_position"));
    assert.ok(f.sqls[1].includes("AND source = 'gps.a'"));
  });

  it("budgets the expanded columns in the bucket guard", async () => {
    const sources = ["a", "b", "c", "d", "e", "f"].map((s) => [P, s]);
    const f = fixture((sql) => (isQ18(sql) ? sources : []));
    await assert.rejects(
      f.provider.getValues(
        all([spec()], {
          to: I("2024-01-02T00:00:00Z"),
          resolution: 1,
        }),
      ),
      /1036800 sample buckets across 6 paths/,
    );
    assert.equal(f.sqls.length, 1);
  });
});

describe("client-side aggregate parameters", () => {
  const rows = (values: (number | null)[]): unknown[][] =>
    values.map((v, i) => [`2024-01-01T00:00:0${i + 1}.000000Z`, v]);
  const sixty = [0, 10, 20, 30, 40, 50];

  const column = async (
    aggregate: string,
    parameter: string[] | undefined,
    values: (number | null)[] = sixty,
  ): Promise<unknown[]> => {
    const f = fixture(() => rows(values));
    const pathSpec = {
      ...spec({ aggregate }),
      parameter,
    };
    if (parameter === undefined) delete pathSpec.parameter;
    const r = await f.provider.getValues(
      request({ context: "self", pathSpecs: [pathSpec] }),
    );
    return r.data.map((row) => row[1]);
  };

  it("uses the defaults the README states", () => {
    assert.equal(SMA_DEFAULT_WINDOW, 5);
    assert.equal(EMA_DEFAULT_ALPHA, 0.2);
  });

  for (const parameter of [
    ["0"],
    ["-1"],
    ["abc"],
    ["2x"],
    ["2.7"],
    [""],
    [],
    undefined,
  ]) {
    it(`sma falls back to 5 for ${JSON.stringify(parameter)}`, async () => {
      assert.deepEqual(await column("sma", parameter), [0, 5, 10, 15, 20, 30]);
    });
  }

  it("sma honours 2", async () => {
    assert.deepEqual(await column("sma", ["2"]), [0, 5, 15, 25, 35, 45]);
  });

  it("sma honours 1", async () => {
    assert.deepEqual(await column("sma", ["1"]), [0, 10, 20, 30, 40, 50]);
  });

  for (const parameter of [
    ["abc"],
    ["0"],
    ["2"],
    ["0.9x"],
    [""],
    [],
    undefined,
  ]) {
    it(`ema falls back to 0.2 for ${JSON.stringify(parameter)}`, async () => {
      const values = await column("ema", parameter);
      assert.ok(values.every((v) => Number.isFinite(v)));
      assert.deepEqual(values, [0, 2, 5.6, 10.48, 16.384, 23.1072]);
    });
  }

  it("ema honours 0.9", async () => {
    assert.deepEqual(
      await column("ema", ["0.9"]),
      [0, 9, 18.9, 28.89, 38.888999999999996, 48.8889],
    );
  });

  it("ema honours 1", async () => {
    assert.deepEqual(await column("ema", ["1"]), [0, 10, 20, 30, 40, 50]);
  });

  it("sma skips nulls without moving the window", async () => {
    assert.deepEqual(await column("sma", ["2"], [0, 10, null, 30]), [
      0,
      5,
      null,
      20,
    ]);
  });

  it("ema repeats the previous value on null", async () => {
    assert.deepEqual(
      await column("ema", ["0.2"], [0, 10, null, 30]),
      [0, 2, 2, 7.6],
    );
  });

  it("middle_index keeps the value at floor(k / 2)", async () => {
    assert.deepEqual(await column("middle_index", []), [
      null,
      null,
      null,
      30,
      null,
      null,
    ]);
    assert.deepEqual(await column("middle_index", [], []), []);
  });

  it("client-side specs never fall back to the string table", async () => {
    const f = fixture(() => []);
    const r = await f.provider.getValues(
      request({
        context: "self",
        pathSpecs: [spec({ aggregate: "sma", parameter: ["5"] })],
      }),
    );
    assert.deepEqual(r.data, []);
    assert.ok(f.sqls.every((s) => !s.includes("SELECT ts, value_str")));
  });
});

describe("assembling data", () => {
  it("unions timestamps across columns and nulls the gaps", async () => {
    const f = fixture((sql) =>
      sql.includes("'a.b'")
        ? [
            ["2024-01-01T00:00:01.000000Z", 1],
            ["2024-01-01T00:00:03.000000Z", 3],
          ]
        : [
            ["2024-01-01T00:00:02.000000Z", false],
            ["2024-01-01T00:00:03.000000Z", 0],
            ["2024-01-01T00:00:03.000000Z", 33],
          ],
    );
    const r = await f.provider.getValues(
      request({ pathSpecs: [spec({ path: "a.b" }), spec({ path: "c.d" })] }),
    );
    assert.deepEqual(r.data, [
      ["2024-01-01T00:00:01.000000Z", 1, null],
      ["2024-01-01T00:00:02.000000Z", null, false],
      ["2024-01-01T00:00:03.000000Z", 3, 33],
    ]);
  });
});

describe("README invariant", () => {
  it("names the sma window and ema alpha defaults", () => {
    const readme = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../README.md",
      ),
      "utf8",
    );
    const v2 = readme.split("### v2")[1].split("### v1")[0];
    assert.ok(
      v2.includes(
        `default window of ${SMA_DEFAULT_WINDOW} or alpha of ${EMA_DEFAULT_ALPHA}`,
      ),
    );
  });
});

describe("aggregate names", () => {
  it("treats an inherited object property name as unknown", async () => {
    const f = fixture(() => [["2024-01-01T00:00:00.000000Z", 1]]);
    await f.provider.getValues(
      request({
        resolution: 60,
        pathSpecs: [spec({ aggregate: "constructor" })],
      }),
    );
    assert.ok(f.sqls[0].includes("avg(value)"), f.sqls[0]);
    assert.ok(!f.sqls[0].includes("function"), f.sqls[0]);
  });

  it("runs the average for an unknown name and reports the name", async () => {
    const f = fixture(() => [["2024-01-01T00:00:00.000000Z", 1]]);
    const result = await f.provider.getValues(
      request({ resolution: 60, pathSpecs: [spec({ aggregate: "bogus" })] }),
    );
    assert.ok(f.sqls[0].includes("avg(value)"), f.sqls[0]);
    assert.equal(result.values[0].method, "bogus");
  });
});

describe("object-valued paths", () => {
  const B0 = "2024-01-01T00:00:00.000000Z";
  const B1 = "2024-01-01T00:01:00.000000Z";
  const B2 = "2024-01-01T00:02:00.000000Z";
  const T1 = "2024-01-01T00:00:01.000100Z";
  const T2 = "2024-01-01T00:00:01.000200Z";
  const T3 = "2024-01-01T00:00:01.000300Z";
  const P = "navigation.attitude";
  const ROLL = `${P}#/roll`;
  const PITCH = `${P}#/pitch`;
  const YAW = `${P}#/yaw`;

  type Rows = unknown[][];
  interface Answers {
    q1?: Rows;
    q3?: Rows;
    q4?: Rows;
    discover?: Rows;
    q11?: Rows;
    q13?: Rows;
    q14?: Rows;
    q15?: Rows;
    q16?: Rows;
    q17?: Rows;
  }

  const isDiscovery = (sql: string): boolean =>
    sql.includes("SELECT DISTINCT path, 'signalk' tbl");
  const BOUND = "2024-01-01T00:59:00.000000Z";
  const isQ11 = (sql: string): boolean => sql.startsWith("SELECT max(ts) FROM");
  const isQ13 = (sql: string): boolean =>
    sql.includes("arrival FROM signalk WHERE");
  const isQ14 = (sql: string): boolean =>
    sql.includes("arrival FROM signalk_str WHERE");
  const isQ15 = (sql: string): boolean =>
    sql.startsWith("SELECT ts, source, path, value FROM signalk WHERE");
  const isQ16 = (sql: string): boolean =>
    sql.startsWith("SELECT ts, source, path, value_str");

  // Q13 and Q14 test rows carry the leaf name after the bucket; a per-leaf
  // statement returns its leaf's rows without it.
  const perLeaf = (sql: string, rows: Rows = []): Rows => {
    const leaf = /path = '((?:[^']|'')*)'/.exec(sql)?.[1].replace(/''/g, "'");
    return rows
      .filter((r) => r[1] === leaf)
      .map(([bucket, , ...rest]) => [bucket, ...rest]);
  };

  const objects = (a: Answers = {}): Fixture =>
    fixture((sql) => {
      if (isDiscovery(sql))
        return (
          a.discover ?? [
            [ROLL, "signalk"],
            [PITCH, "signalk"],
            [YAW, "signalk"],
          ]
        );
      if (isQ11(sql)) return a.q11 ?? [[BOUND]];
      if (isQ13(sql)) return perLeaf(sql, a.q13);
      if (isQ14(sql)) return perLeaf(sql, a.q14);
      if (isQ15(sql)) return a.q15 ?? [];
      if (isQ16(sql)) return a.q16 ?? [];
      if (sql.startsWith("SELECT ts FROM signalk_str")) return a.q17 ?? [];
      if (sql.includes("LIMIT 50000")) return a.q3 ?? [];
      if (sql.includes("FROM signalk_str")) return a.q4 ?? [];
      return a.q1 ?? [];
    });

  const attitude = (
    over: Record<string, unknown> = {},
    requestOver: Record<string, unknown> = {},
  ): history.ValuesRequest =>
    request({
      context: "self",
      resolution: 60,
      pathSpecs: [spec({ path: P, ...over })],
      ...requestOver,
    });

  const firstData = async (
    a: Answers,
    over: Record<string, unknown> = {},
    requestOver: Record<string, unknown> = {},
  ): Promise<unknown> =>
    (await objects(a).provider.getValues(attitude(over, requestOver))).data;

  const refusal = (aggregate: string, path = P): { message: string } => ({
    message: `Aggregate ${aggregate} does not apply to object path ${path}: use first, last or middle_index`,
  });

  it("refuses a downsampled average after discovery", async () => {
    const f = objects();
    await assert.rejects(f.provider.getValues(attitude()), refusal("average"));
    assert.equal(f.sqls.length, 3);
    assert.ok(f.sqls[0].includes("agg_value"));
    assert.ok(f.sqls[1].includes("last(value_str) as value_str"));
    assert.ok(isDiscovery(f.sqls[2]));
  });

  for (const aggregate of ["min", "max", "mid", "bogus", "constructor"]) {
    it(`refuses ${aggregate} on an object path`, async () => {
      const f = objects();
      await assert.rejects(
        f.provider.getValues(attitude({ aggregate })),
        refusal(aggregate),
      );
      assert.equal(f.sqls.length, 3);
    });
  }

  it("takes every field of the latest delta under last, one leaf per statement", async () => {
    const f = objects({
      q13: [
        [B0, ROLL, 3, T2],
        [B0, PITCH, 2, T2],
        [B0, YAW, 1, T2],
      ],
    });
    const r = await f.provider.getValues(attitude({ aggregate: "last" }));
    assert.equal(f.sqls.length, 7);
    const w1 =
      "ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2024-01-01T01:00:00.000Z' AND context = 'self'";
    assert.equal(
      f.sqls[2],
      `SELECT DISTINCT path, 'signalk' tbl FROM signalk WHERE ${w1} UNION SELECT DISTINCT path, 'signalk_str' tbl FROM signalk_str WHERE ${w1}`,
    );
    assert.equal(f.sqls[3], "SELECT max(ts) FROM signalk");
    assert.equal(
      f.sqls[4],
      `SELECT ts, last(value) value, max(ts) arrival FROM signalk WHERE ${w1} AND path = '${ROLL}' AND ts < '${BOUND}' SAMPLE BY 60s ORDER BY ts`,
    );
    assert.ok(f.sqls[5].includes(`path = '${PITCH}'`));
    assert.ok(f.sqls[6].includes(`path = '${YAW}'`));
    assert.ok(f.sqls.slice(3).every((q) => !q.includes("signalk_str")));
    assert.deepEqual(r.data, [[B0, { roll: 3, pitch: 2, yaw: 1 }]]);
    assert.equal(r.values[0].method, "last");
  });

  it("takes the earliest delta under first", async () => {
    const f = objects({ q13: [[B0, ROLL, 1, T1]] });
    const r = await f.provider.getValues(attitude({ aggregate: "first" }));
    assert.ok(
      f.sqls.find(isQ13)?.includes("first(value) value, min(ts) arrival"),
    );
    assert.deepEqual(r.data, [[B0, { roll: 1 }]]);
  });
  it("bounds every leaf statement by its table's newest ts", async () => {
    const f = objects({ q11: [[T2]] });
    await f.provider.getValues(attitude({ aggregate: "last" }));
    const leafReads = f.sqls.filter(isQ13);
    assert.equal(leafReads.length, 3);
    assert.ok(leafReads.every((q) => q.includes(`AND ts < '${T2}' SAMPLE BY`)));
    assert.equal(f.sqls.filter(isQ11).length, 1);
  });

  it("leaves the leaf statements unbounded when the table has no max", async () => {
    const f = objects({ q11: [[null]] });
    await f.provider.getValues(attitude({ aggregate: "last" }));
    const leafReads = f.sqls.filter(isQ13);
    assert.equal(leafReads.length, 3);
    assert.ok(leafReads.every((q) => /path = '[^']*' SAMPLE BY/.test(q)));
  });

  it("refuses an unreadable table bound", async () => {
    const f = objects({ q11: [["not a timestamp"]] });
    await assert.rejects(
      f.provider.getValues(attitude({ aggregate: "last" })),
      { message: "Unreadable max(ts) of signalk: not a timestamp" },
    );
    assert.equal(f.sqls.filter(isQ13).length, 0);
  });

  it("does not mix fields of different deltas under last", async () => {
    assert.deepEqual(
      await firstData(
        {
          q13: [
            [B0, ROLL, 2, T2],
            [B0, PITCH, 1, T1],
          ],
        },
        { aggregate: "last" },
      ),
      [[B0, { roll: 2 }]],
    );
  });

  it("orders deltas in one millisecond by arrival", async () => {
    const rows = [
      [B0, ROLL, 1, T1],
      [B0, PITCH, 1, T1],
      [B0, ROLL, 2, T2],
    ];
    assert.deepEqual(await firstData({ q13: rows }, { aggregate: "last" }), [
      [B0, { roll: 2 }],
    ]);
    assert.deepEqual(await firstData({ q13: rows }, { aggregate: "first" }), [
      [B0, { roll: 1, pitch: 1 }],
    ]);
  });

  it("takes the later of two same-millisecond deltas under last", async () => {
    assert.deepEqual(
      await firstData({ q13: [[B0, ROLL, 2, T2]] }, { aggregate: "last" }),
      [[B0, { roll: 2 }]],
    );
  });

  it("reads a text-only object from its text leaves", async () => {
    const M = "notifications.mob";
    const f = objects({
      discover: [
        [`${M}#/state`, "signalk_str"],
        [`${M}#/message`, "signalk_str"],
        [`${M}#/on`, "signalk_str"],
      ],
      q14: [
        [B0, `${M}#/state`, "normal", null, T2],
        [B0, `${M}#/message`, "y", null, T2],
        [B0, `${M}#/on`, "true", "boolean", T2],
      ],
    });
    const r = await f.provider.getValues(
      attitude({ path: M, aggregate: "last" }),
    );
    assert.ok(f.sqls.every((s) => !isQ13(s)));
    assert.deepEqual(f.sqls.filter(isQ11), ["SELECT max(ts) FROM signalk_str"]);
    const q14 = f.sqls.find(isQ14) ?? "";
    assert.ok(
      q14.includes(
        "SELECT ts, last(value_str) value_str, last(value_kind) value_kind, max(ts) arrival",
      ),
      q14,
    );
    assert.deepEqual(r.data, [
      [B0, { state: "normal", message: "y", on: true }],
    ]);
  });

  it("reduces a field with numbers and text as a number", async () => {
    assert.deepEqual(
      await firstData(
        {
          discover: [
            [ROLL, "signalk"],
            [ROLL, "signalk_str"],
          ],
          q13: [[B0, ROLL, 1, T1]],
          q14: [[B0, ROLL, "x", null, T1]],
        },
        { aggregate: "last" },
      ),
      [[B0, { roll: 1 }]],
    );
  });

  it("nulls an empty bucket inside the timeline and omits absent fields", async () => {
    assert.deepEqual(
      await firstData(
        {
          q13: [
            [B0, ROLL, 1, T1],
            [B0, PITCH, 2, T1],
            [B2, ROLL, 3, "2024-01-01T00:02:01.000100Z"],
          ],
        },
        { aggregate: "last" },
      ),
      [
        [B0, { roll: 1, pitch: 2 }],
        [B1, null],
        [B2, { roll: 3 }],
      ],
    );
  });

  it("unescapes pointer keys", async () => {
    const names = [`${P}#/a~1b`, `${P}#/c~0d`, `${P}#/~01`];
    assert.deepEqual(
      await firstData(
        {
          discover: names.map((n) => [n, "signalk"]),
          q13: names.map((n, i) => [B0, n, i + 1, T1]),
        },
        { aggregate: "last" },
      ),
      [[B0, { "a/b": 1, "c~d": 2, "~1": 3 }]],
    );
  });

  it("keeps a field named __proto__ as an own field", async () => {
    const name = `${P}#/__proto__`;
    const data = (await firstData(
      { discover: [[name, "signalk"]], q13: [[B0, name, 1, T1]] },
      { aggregate: "last" },
    )) as [string, Record<string, unknown>][];
    assert.ok(Object.hasOwn(data[0][1], "__proto__"));
    assert.equal(JSON.stringify(data[0][1]), '{"__proto__":1}');
    const raw = (await firstData(
      { discover: [[name, "signalk"]], q15: [[T1, "a", name, 1]] },
      {},
      { resolution: undefined },
    )) as [string, unknown][];
    assert.equal(JSON.stringify(raw[0][1]), '{"__proto__":1}');
  });

  it("quotes a leaf name holding an apostrophe", async () => {
    const f = objects({
      discover: [["q#/it's", "signalk"]],
      q13: [[B0, "q#/it's", 5, T1]],
    });
    const r = await f.provider.getValues(
      attitude({ path: "q", aggregate: "last" }),
    );
    const q13 = f.sqls.find(isQ13) ?? "";
    assert.ok(q13.includes("path = 'q#/it''s'"), q13);
    assert.deepEqual(r.data, [[B0, { "it's": 5 }]]);
  });

  it("selects leaves by prefix in the provider, without LIKE", async () => {
    const f = objects({
      discover: [
        ["a_b#/x", "signalk"],
        ["aXb#/x", "signalk"],
      ],
      q13: [[B0, "a_b#/x", 1, T1]],
    });
    const r = await f.provider.getValues(
      attitude({ path: "a_b", aggregate: "last" }),
    );
    assert.deepEqual(
      f.sqls.filter(isQ13).map((q) => q.includes("path = 'a_b#/x'")),
      [true],
    );
    assert.equal(f.sqls.length, 5);
    assert.ok(f.sqls.every((s) => !/LIKE|starts_with|aXb/i.test(s)));
    assert.deepEqual(r.data, [[B0, { x: 1 }]]);
  });

  it("filters the object read, not discovery, by sourceRef", async () => {
    const f = objects({ q13: [[B0, ROLL, 1, T1]] });
    await f.provider.getValues(
      attitude({ aggregate: "last", sourceRef: "gps.main" }),
    );
    assert.ok(!f.sqls[2].includes("source ="), f.sqls[2]);
    const q13 = f.sqls.find(isQ13) ?? "";
    assert.ok(q13.includes("AND source = 'gps.main'"), q13);
  });

  it("stops after discovery when the path has no leaves", async () => {
    const f = objects({ discover: [] });
    const r = await f.provider.getValues(attitude());
    assert.equal(f.sqls.length, 3);
    assert.deepEqual(r.data, []);
    assert.equal(r.values[0].method, "last");
  });

  it("discovers once per request", async () => {
    const f = objects({ q13: [[B0, ROLL, 1, T1]] });
    await f.provider.getValues(
      request({
        context: "self",
        resolution: 60,
        pathSpecs: [
          spec({ path: P, aggregate: "last" }),
          spec({ path: "notifications.mob", aggregate: "last" }),
        ],
      }),
    );
    assert.equal(f.sqls.filter(isDiscovery).length, 1);
    assert.deepEqual(f.sqls.filter(isQ11), ["SELECT max(ts) FROM signalk"]);
  });

  it("returns the numeric series when scalar rows exist", async () => {
    const f = objects({ q1: [[B0, 4.2]], q13: [[B0, ROLL, 1, T1]] });
    const r = await f.provider.getValues(attitude());
    assert.equal(f.sqls.length, 1);
    assert.deepEqual(r.data, [[B0, 4.2]]);
  });

  it("returns the string series when scalar text rows exist", async () => {
    const f = objects({
      q4: [[B0, "on", null]],
      q13: [[B0, ROLL, 1, T1]],
    });
    const r = await f.provider.getValues(attitude());
    assert.equal(f.sqls.length, 2);
    assert.deepEqual(r.data, [[B0, "on"]]);
  });

  const rawRows = [
    [T1, "a", ROLL, 1],
    [T2, "b", ROLL, 2],
    [T3, null, PITCH, 3],
  ];

  it("reads one object per delta when raw", async () => {
    const f = objects({ q15: rawRows });
    const r = await f.provider.getValues(
      attitude({}, { resolution: undefined }),
    );
    assert.equal(f.sqls[3], "SELECT max(ts) FROM signalk");
    assert.equal(
      f.sqls[4],
      `SELECT ts, source, path, value FROM signalk WHERE ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2024-01-01T01:00:00.000Z' AND context = 'self' AND path IN ('${ROLL}', '${PITCH}', '${YAW}') AND ts < '${BOUND}' ORDER BY ts LIMIT 30001`,
    );
    assert.deepEqual(r.data, [
      [T1, { roll: 1 }],
      [T2, { roll: 2 }],
      [T3, { pitch: 3 }],
    ]);
    assert.equal(r.values[0].method, "average");
  });

  const MODE = `${P}#/mode`;
  const msAt = (d: number, micros = "123"): string =>
    new Date(Date.UTC(2024, 0, 1) + d).toISOString().replace("Z", `${micros}Z`);
  /** Three-field deltas, one per millisecond from `from` on. */
  const attitudeRows = (count: number, from = 0): unknown[][] =>
    Array.from({ length: count }, (_, i) => {
      const ts = msAt(from + i);
      return [
        [ts, "a", ROLL, i],
        [ts, "a", PITCH, i],
        [ts, "a", YAW, i],
      ];
    }).flat();
  const raw = async (a: Answers): Promise<unknown[][]> =>
    (await firstData(a, {}, { resolution: undefined })) as unknown[][];

  it("keeps an exactly full read whole", async () => {
    const rows = attitudeRows(10000);
    const last = msAt(9998, "456");
    rows.splice(
      -3,
      3,
      [last, "a", ROLL, 0],
      [last, "a", PITCH, 0],
      [last, "a", YAW, 0],
    );
    assert.equal(rows.length, 30000);
    assert.equal((await raw({ q15: rows })).length, 10000);
  });

  it("drops the partial last delta of a truncated read", async () => {
    const rows = [...attitudeRows(10000), [msAt(9999, "456"), "a", ROLL, 0]];
    assert.equal(rows.length, 30001);
    assert.equal((await raw({ q15: rows })).length, 10000);
  });

  const withMode: Rows = [
    [ROLL, "signalk"],
    [PITCH, "signalk"],
    [YAW, "signalk"],
    [MODE, "signalk_str"],
  ];

  it("drops a truncated delta and the other table's rows at its ts", async () => {
    const rows = [...attitudeRows(10000), [msAt(10000), "a", ROLL, 1]];
    assert.equal(rows.length, 30001);
    const data = await raw({
      discover: withMode,
      q15: rows,
      q16: [[msAt(10000), "a", MODE, "x", null]],
    });
    assert.equal(data.length, 10000);
    assert.ok(
      data.every(([, fields]) => !Object.hasOwn(fields as object, "mode")),
    );
  });

  it("cuts at a truncated text read", async () => {
    const text = Array.from({ length: 9999 }, (_, i) => [
      msAt(i),
      "a",
      MODE,
      `m${i}`,
      null,
    ]);
    text.push(
      [msAt(9999, "100"), "a", MODE, "last", null],
      [msAt(9999, "200"), "0", MODE, "cut", null],
    );
    const f = objects({
      discover: [
        [ROLL, "signalk"],
        [MODE, "signalk_str"],
      ],
      q15: [[msAt(9999, "300"), "0", ROLL, 1]],
      q16: text,
    });
    const r = await f.provider.getValues(
      attitude({}, { resolution: undefined }),
    );
    assert.ok(f.sqls.find(isQ16)?.endsWith("LIMIT 10001"));
    const data = r.data as unknown[][];
    assert.equal(data.length, 10000);
    assert.ok(
      data.every(([, fields]) => !Object.hasOwn(fields as object, "roll")),
    );
  });

  for (const [aggregate, numeric, text, at] of [
    ["first", 3, "x", "100"],
    ["last", 2, "y", "200"],
  ] as const) {
    it(`reads the fields at the ${aggregate} ts`, async () => {
      const arrival = msAt(0, at);
      const f = objects({
        discover: [
          [ROLL, "signalk"],
          [MODE, "signalk_str"],
        ],
        q13: [[B0, ROLL, numeric, arrival]],
        q14: [[B0, MODE, text, null, arrival]],
      });
      const r = await f.provider.getValues(attitude({ aggregate }));
      const [take, edge] =
        aggregate === "first" ? ["first", "min"] : ["last", "max"];
      assert.ok(
        f.sqls
          .find(isQ13)
          ?.startsWith(`SELECT ts, ${take}(value) value, ${edge}(ts) arrival`),
      );
      assert.deepEqual(r.data, [[B0, { roll: numeric, mode: text }]]);
    });
  }

  it("keeps a truncated read that falls at one ts", async () => {
    const rows = Array.from({ length: 30001 }, (_, i) => [
      T1,
      `s${String(i).padStart(5, "0")}`,
      ROLL,
      i,
    ]);
    const data = await raw({ q15: rows });
    assert.equal(data.length, 1);
  });

  const client: Answers = {
    discover: [
      [ROLL, "signalk"],
      [PITCH, "signalk"],
      [YAW, "signalk"],
      [`${P}#/mode`, "signalk_str"],
    ],
    q15: [
      [T1, "a", ROLL, 0],
      [T1, "a", PITCH, 10],
      [T2, "a", ROLL, 10],
      [T3, "a", ROLL, 20],
      [T3, "a", PITCH, 30],
    ],
    q16: [[T1, "a", `${P}#/mode`, "x", null]],
  };

  it("refuses sma after discovery", async () => {
    const f = objects(client);
    await assert.rejects(
      f.provider.getValues(attitude({ aggregate: "sma", parameter: ["2"] })),
      refusal("sma"),
    );
    assert.equal(f.sqls.length, 3);
    assert.ok(f.sqls[0].includes("LIMIT 50000"), f.sqls[0]);
    assert.equal(
      f.sqls[1],
      `SELECT ts FROM signalk_str WHERE ts >= '2024-01-01T00:00:00.000Z' AND ts <= '2024-01-01T01:00:00.000Z' AND context = 'self' AND path = '${P}' LIMIT 1`,
    );
    assert.ok(isDiscovery(f.sqls[2]));
  });

  it("refuses ema", async () => {
    await assert.rejects(
      objects(client).provider.getValues(
        attitude({ aggregate: "ema", parameter: ["0.5"] }),
      ),
      refusal("ema"),
    );
  });

  it("refuses ema on a raw read too", async () => {
    await assert.rejects(
      objects(client).provider.getValues(
        attitude({ aggregate: "ema" }, { resolution: undefined }),
      ),
      refusal("ema"),
    );
  });

  it("keeps the whole middle delta with middle_index", async () => {
    const f = objects(client);
    const r = await f.provider.getValues(
      attitude({ aggregate: "middle_index" }),
    );
    assert.equal(f.sqls.length, 7);
    assert.ok(isDiscovery(f.sqls[2]));
    assert.equal(f.sqls[3], "SELECT max(ts) FROM signalk");
    assert.ok(isQ15(f.sqls[4]) && f.sqls[4].endsWith("LIMIT 150001"));
    assert.equal(f.sqls[5], "SELECT max(ts) FROM signalk_str");
    assert.ok(isQ16(f.sqls[6]) && f.sqls[6].endsWith("LIMIT 50001"));
    assert.deepEqual(r.data, [
      [T1, null],
      [T2, { roll: 10 }],
      [T3, null],
    ]);
    assert.deepEqual(
      await firstData(
        {
          discover: [
            [ROLL, "signalk"],
            [`${P}#/mode`, "signalk_str"],
          ],
          q15: [
            [T1, "a", ROLL, 0],
            [T2, "a", ROLL, 1],
          ],
          q16: [[T2, "a", `${P}#/mode`, "x", null]],
        },
        { aggregate: "middle_index" },
      ),
      [
        [T1, null],
        [T2, { roll: 1, mode: "x" }],
      ],
    );
  });

  it("keeps a later non-null value when deltas share a timestamp", async () => {
    const next = "2024-01-01T00:00:01.001100Z";
    assert.deepEqual(
      await firstData(
        {
          q15: [
            [T1, "a", ROLL, 0],
            [next, "a", ROLL, 1],
            [next, "b", ROLL, 2],
          ],
        },
        { aggregate: "middle_index" },
      ),
      [
        [T1, null],
        [next, { roll: 1 }],
      ],
    );
  });

  it("leaves a client-side column empty when scalar text rows exist", async () => {
    const f = objects({ q17: [[B0]], q15: [[T1, "a", ROLL, 1]] });
    const r = await f.provider.getValues(attitude({ aggregate: "sma" }));
    assert.equal(f.sqls.length, 2);
    assert.deepEqual(r.data, []);
  });

  it("keeps a numeric client-side column", async () => {
    const f = objects({ q3: [[B0, 4]] });
    const r = await f.provider.getValues(attitude({ aggregate: "sma" }));
    assert.equal(f.sqls.length, 1);
    assert.deepEqual(r.data, [[B0, 4]]);
  });

  it("leaves navigation.position unchanged", async () => {
    const f = objects();
    await f.provider.getValues(
      attitude({ path: "navigation.position", aggregate: "first" }),
    );
    assert.equal(f.sqls.length, 1);
    assert.ok(f.sqls[0].includes("signalk_position"));
    assert.ok(!f.sqls[0].includes("DISTINCT"));
  });
});

describe("object paths in discovery", () => {
  const range = {
    from: I("2024-01-01T00:00:00Z"),
    to: I("2024-01-01T01:00:00Z"),
  } as unknown as history.PathsRequest;

  it("lists an object path once and no pointer name", async () => {
    const f = fixture(() => [
      ["navigation.attitude#/pitch"],
      ["navigation.attitude#/roll"],
      ["navigation.position"],
    ]);
    assert.deepEqual(await f.provider.getPaths(range), [
      "navigation.attitude",
      "navigation.position",
    ]);
  });

  it("lists a scalar path with leaves once", async () => {
    const f = fixture(() => [["a.b"], ["a.b#/x"], ["a.bc"]]);
    assert.deepEqual(await f.provider.getPaths(range), ["a.b", "a.bc"]);
  });
});
