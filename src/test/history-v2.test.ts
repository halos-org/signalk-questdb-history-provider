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
    assert.ok(f.sqls.every((s) => s.includes("SAMPLE BY 1s")));
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
      assert.equal(f.sqls.length, 1);
      assert.ok(f.sqls[0].includes("LIMIT 50000"));
      assert.ok(!f.sqls[0].includes("SAMPLE BY"));
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
    assert.equal(r.values[0].sourceRef, "gps.main");
    assert.ok(!("sourceRef" in r.values[1]));
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
    assert.equal(f.sqls.length, 1);
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
