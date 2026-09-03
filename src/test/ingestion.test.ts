// The ingestion surface: filter matching, rate resolution, the sampling
// gate, identity deltas, routing by kind, and one-level flattening.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PathFilter } from "../ingestion/path-filter.js";
import { SamplingGate, SamplingPolicy } from "../ingestion/sampling.js";
import { Recorder, type DeltaLike } from "../ingestion/recorder.js";
import { effectiveConfig } from "../config/effective.js";
import type { Sample } from "../ilp/line.js";

const SELF = "vessels.urn:mrn:imo:mmsi:123456789";

describe("path filter matching", () => {
  const literal = new PathFilter("exclude", ["electrical.batteries.12v.name"]);
  const globs = new PathFilter("exclude", [
    "navigation.gnss.*",
    "environment.*.temperature",
  ]);

  it("a literal matches by equality only", () => {
    assert.ok(literal.matches("electrical.batteries.12v.name"));
    assert.ok(!literal.matches("electrical.batteries.12v.voltage"));
    assert.ok(!literal.matches("electrical.batteries.12v.name.extra"));
  });

  it("globs match per minimatch", () => {
    assert.ok(globs.matches("navigation.gnss.satellites"));
    assert.ok(!globs.matches("navigation.speedOverGround"));
    assert.ok(globs.matches("environment.water.temperature"));
  });

  it("an empty list records everything in include mode", () => {
    const filter = new PathFilter("include", []);
    assert.ok(filter.admits("navigation.position"));
    assert.ok(filter.admits("a.b"));
  });

  it("an empty list records everything in exclude mode", () => {
    const filter = new PathFilter("exclude", []);
    assert.ok(filter.admits("navigation.position"));
    assert.ok(filter.admits("a.b"));
  });

  it("include mode records matching paths only", () => {
    const filter = new PathFilter("include", ["a.b"]);
    assert.ok(filter.admits("a.b"));
    assert.ok(!filter.admits("a.c"));
  });

  it("exclude mode drops matching paths", () => {
    const filter = new PathFilter("exclude", ["a.*"]);
    assert.ok(!filter.admits("a.b"));
    assert.ok(filter.admits("b.a"));
  });

  it("a mode other than exclude behaves as include", () => {
    const filter = new PathFilter("Exclude", ["a.b"]);
    assert.ok(filter.admits("a.b"));
    assert.ok(!filter.admits("a.c"));
  });

  it("matches the mixed pattern list as specified", () => {
    const filter = new PathFilter("exclude", [
      "design.*",
      "electrical.batteries.12v.name",
      "navigation.gnss.*",
      "environment.*.temperature",
      "tanks.fuel.*.currentLevel",
      "watch.*",
      "notifications.*",
    ]);
    for (const path of [
      "design.aisShipType",
      "electrical.batteries.12v.name",
      "navigation.gnss.satellites",
      "environment.water.temperature",
      "environment.inside.engineRoom.temperature",
      "tanks.fuel.0.currentLevel",
      "watch.x",
    ]) {
      assert.ok(filter.matches(path), `${path} should match`);
    }
    for (const path of [
      "electrical.batteries.12v.voltage",
      "navigation.speedOverGround",
      "watch",
      "design",
      "a.b.c",
    ]) {
      assert.ok(!filter.matches(path), `${path} should not match`);
    }
  });

  it("a string pattern list iterates as one-character patterns", () => {
    const filter = new PathFilter("exclude", "a*");
    assert.ok(!filter.admits("anything"));
  });

  it("a non-iterable pattern list throws at construction", () => {
    assert.throws(() => new PathFilter("exclude", 5));
  });
});

describe("sampling rate resolution", () => {
  const DEFAULT = 2000;
  const policy = (rates: Record<string, unknown>): SamplingPolicy =>
    new SamplingPolicy(DEFAULT, rates);

  it("resolves a literal entry", () => {
    const p = policy({ "navigation.position": 500 });
    assert.equal(p.rateFor("navigation.position"), 500);
    assert.equal(p.rateFor("navigation.speedOverGround"), DEFAULT);
  });

  it("resolves a glob entry", () => {
    const p = policy({ "environment.wind.*": 200 });
    assert.equal(p.rateFor("environment.wind.speedApparent"), 200);
    assert.equal(p.rateFor("environment.water.temperature"), DEFAULT);
  });

  it("ignores non-positive entries", () => {
    const p = policy({ "a.*": 0, "b.*": -1, "c.*": 100 });
    assert.equal(p.rateFor("a.x"), DEFAULT);
    assert.equal(p.rateFor("b.x"), DEFAULT);
    assert.equal(p.rateFor("c.x"), 100);
  });

  it("a literal wins over a glob", () => {
    const p = policy({ "tanks.*": 10000, "tanks.fuel.0.level": 250 });
    assert.equal(p.rateFor("tanks.fuel.0.level"), 250);
    assert.equal(p.rateFor("tanks.water.0.level"), 10000);
  });

  it("an empty object resolves the default", () => {
    assert.equal(policy({}).rateFor("anything.at.all"), DEFAULT);
  });

  it("a zero override never matches", () => {
    assert.equal(policy({ "a.*": 0 }).rateFor("a.x"), DEFAULT);
    assert.equal(policy({ "a.*": 5 }).rateFor("a.x"), 5);
  });

  it("gives effective rates against the default", () => {
    const p = policy({ "environment.wind.*": 200 });
    assert.equal(p.rateFor("environment.wind.angle"), 200);
    assert.equal(p.rateFor("navigation.position"), 2000);
    assert.equal(
      policy({ "navigation.*": 0 }).rateFor("navigation.position"),
      2000,
    );
  });

  it("compares numeric strings as numbers", () => {
    const p = new SamplingPolicy("2000", { "a.*": "200" });
    assert.equal(p.rateFor("a.x"), 200);
    assert.equal(p.rateFor("b.x"), 2000);
    assert.ok(Number.isNaN(new SamplingPolicy("abc", {}).rateFor("x")));
  });
});

describe("sampling gate", () => {
  const T0 = 1700000000000;

  it("keeps one window per path and context", () => {
    const gate = new SamplingGate();
    assert.ok(gate.admit("navigation.position", "vessels.a", 2000, T0));
    assert.ok(gate.admit("navigation.position", "vessels.b", 2000, T0 + 10));
    assert.ok(gate.admit("navigation.position", "self", 2000, T0 + 20));
  });

  it("admits again exactly at the rate", () => {
    const gate = new SamplingGate();
    assert.ok(gate.admit("a.b", "self", 2000, T0));
    assert.ok(!gate.admit("a.b", "self", 2000, T0 + 1999));
    assert.ok(gate.admit("a.b", "self", 2000, T0 + 2000));
  });

  it("a rejection does not move the window", () => {
    const gate = new SamplingGate();
    gate.admit("a.b", "self", 2000, T0);
    assert.ok(!gate.admit("a.b", "self", 2000, T0 + 1500));
    assert.ok(gate.admit("a.b", "self", 2000, T0 + 2100));
  });

  it("a non-positive rate never rejects", () => {
    const gate = new SamplingGate();
    assert.ok(gate.admit("a.b", "self", 0, T0));
    assert.ok(gate.admit("a.b", "self", 0, T0 + 1));
    assert.ok(gate.admit("a.b", "self", -5, T0 + 2));
    assert.ok(gate.admit("a.b", "self", NaN, T0 + 3));
  });

  it("a restart begins with empty windows", () => {
    const gate = new SamplingGate();
    gate.admit("a.b", "self", 2000, T0);
    gate.clear();
    assert.ok(gate.admit("a.b", "self", 2000, T0 + 1));
  });

  const fill = (gate: SamplingGate): void => {
    for (let i = 0; i < 10000; i++) gate.admit("p", `vessels.${i}`, 2000, T0);
  };

  it("sweeps aged pairs at the cap", () => {
    const gate = new SamplingGate();
    fill(gate);
    assert.ok(gate.admit("p", "vessels.new", 2000, T0 + 2500));
  });

  it("forgets every pair when the sweep leaves the cap full", () => {
    const gate = new SamplingGate();
    fill(gate);
    assert.ok(gate.admit("p", "vessels.new", 2000, T0 + 100));
    assert.ok(gate.admit("p", "vessels.1", 2000, T0 + 200));
  });
});

interface Harness {
  samples: Sample[];
  handle: (delta: DeltaLike) => void;
  recorder: Recorder;
}

function harness(
  stored: Record<string, unknown> = {},
  now: () => number = () => 1700000000000,
): Harness {
  const cfg = effectiveConfig(stored);
  const samples: Sample[] = [];
  const recorder = new Recorder({
    selfContext: SELF,
    recordSelf: cfg.recordSelf,
    recordOthers: cfg.recordOthers,
    filter: new PathFilter(cfg.pathFilter.mode, cfg.pathFilter.paths),
    sampling: new SamplingPolicy(cfg.defaultSamplingRate, cfg.samplingRates),
    gate: new SamplingGate(),
    emit: (sample) => samples.push(sample),
    now,
  });
  return { samples, recorder, handle: (delta) => recorder.handle(delta) };
}

const paths = (samples: Sample[]): (string | undefined)[] =>
  samples.map((s) => ("path" in s ? s.path : undefined));

describe("configuration normalisation", () => {
  it("records everything at the default rate without pathFilter and samplingRates", () => {
    let t = 1700000000000;
    const h = harness({}, () => t);
    h.handle({ path: "navigation.position", value: 1, context: SELF });
    h.handle({ path: "environment.wind.angle", value: 1, context: SELF });
    t += 1999;
    h.handle({ path: "navigation.position", value: 2, context: SELF });
    h.handle({ path: "environment.wind.angle", value: 2, context: SELF });
    assert.deepEqual(paths(h.samples), [
      "navigation.position",
      "environment.wind.angle",
    ]);
  });

  it("include mode with no list records everything", () => {
    const h = harness({ pathFilter: { mode: "include" } });
    h.handle({ path: "navigation.position", value: 1, context: SELF });
    h.handle({ path: "a.b", value: 1, context: SELF });
    assert.deepEqual(paths(h.samples), ["navigation.position", "a.b"]);
  });

  it("a list with no mode excludes", () => {
    const h = harness({ pathFilter: { paths: ["navigation.*"] } });
    h.handle({ path: "navigation.position", value: 1, context: SELF });
    h.handle({ path: "a.b", value: 1, context: SELF });
    assert.deepEqual(paths(h.samples), ["a.b"]);
  });

  it("a full filter and sampling rates are used as stored", () => {
    let t = 1700000000000;
    const h = harness(
      {
        pathFilter: {
          mode: "include",
          paths: ["navigation.*", "environment.*"],
        },
        samplingRates: { "environment.wind.*": 200 },
      },
      () => t,
    );
    h.handle({ path: "navigation.position", value: 1, context: SELF });
    h.handle({ path: "a.b", value: 1, context: SELF });
    h.handle({ path: "environment.wind.angle", value: 1, context: SELF });
    t += 200;
    h.handle({ path: "environment.wind.angle", value: 2, context: SELF });
    assert.deepEqual(paths(h.samples), [
      "navigation.position",
      "environment.wind.angle",
      "environment.wind.angle",
    ]);
  });

  it("records self and others without the toggles", () => {
    const h = harness({});
    h.handle({ path: "a.b", value: 1, context: SELF });
    h.handle({ path: "a.b", value: 1, context: "vessels.a" });
    assert.deepEqual(
      h.samples.map((s) => s.context),
      ["self", "vessels.a"],
    );
  });

  it("records nothing with both toggles false", () => {
    const h = harness({ recordSelf: false, recordOthers: false });
    h.handle({ path: "a.b", value: 1, context: SELF });
    h.handle({ path: "a.b", value: 1, context: "vessels.a" });
    h.handle({ path: "", value: { name: "x" }, context: SELF });
    assert.deepEqual(h.samples, []);
  });

  it("carries a non-empty $source and drops an empty one", () => {
    const h = harness({});
    h.handle({ path: "a.b", value: 1, context: SELF, $source: "gps.main" });
    h.handle({ path: "a.c", value: 1, context: SELF, $source: "" });
    h.handle({ path: "a.d", value: 1, context: SELF, $source: 5 });
    assert.deepEqual(
      h.samples.map((s) => s.source),
      ["gps.main", undefined, undefined],
    );
  });
});

describe("vessel identity deltas", () => {
  it("records a name as an identity row", () => {
    const h = harness({});
    h.handle({ path: "", value: { name: "Sea Breeze" }, context: SELF });
    assert.deepEqual(h.samples, [
      {
        kind: "string",
        path: "name",
        context: "self",
        source: undefined,
        value: "Sea Breeze",
        valueKind: "identity",
      },
    ]);
  });

  it("ignores mmsi beside the name", () => {
    const h = harness({});
    h.handle({
      path: "",
      value: { name: "Sea Breeze", mmsi: "244813000" },
      context: "vessels.urn:mrn:imo:mmsi:244813000",
    });
    assert.deepEqual(paths(h.samples), ["name"]);
    assert.equal(h.samples[0].kind, "string");
  });

  it("a data path named name stays data", () => {
    const h = harness({});
    h.handle({ path: "name", value: "Sea Breeze", context: SELF });
    assert.deepEqual(h.samples, [
      {
        kind: "string",
        path: "name",
        context: "self",
        source: undefined,
        value: "Sea Breeze",
      },
    ]);
  });

  it("an object with name under a path is an ordinary object", () => {
    const h = harness({});
    h.handle({ path: "navigation.state", value: { name: "x" }, context: SELF });
    assert.deepEqual(h.samples, [
      {
        kind: "string",
        path: "navigation.state.name",
        context: "self",
        source: undefined,
        value: "x",
      },
    ]);
  });

  for (const value of [
    { mmsi: "244813000" },
    { name: "" },
    { name: "   " },
    { name: 42 },
    null,
    "just a string",
  ]) {
    it(`discards an empty-path delta with value ${JSON.stringify(value)}`, () => {
      const h = harness({});
      h.handle({ path: "", value, context: SELF });
      assert.deepEqual(h.samples, []);
    });
  }

  it("deduplicates an unchanged name and bypasses the filter", () => {
    const h = harness({ pathFilter: { mode: "include", paths: ["a.*"] } });
    h.handle({ path: "", value: { name: "Sea Breeze" }, context: SELF });
    h.handle({ path: "", value: { name: "Sea Breeze" }, context: SELF });
    assert.equal(h.samples.length, 1);
  });

  it("reports the name again after the buffer dropped lines", () => {
    let t = 1700000000000;
    const h = harness({}, () => t);
    h.handle({ path: "", value: { name: "Sea Breeze" }, context: SELF });
    h.recorder.forgetNames();
    t += 2000;
    h.handle({ path: "", value: { name: "Sea Breeze" }, context: SELF });
    assert.equal(h.samples.length, 2);
  });

  it("does not remember a name the gate rejected", () => {
    let t = 1700000000000;
    const h = harness({}, () => t);
    h.handle({ path: "", value: { name: "One" }, context: SELF });
    h.handle({ path: "", value: { name: "Two" }, context: SELF });
    t += 2000;
    h.handle({ path: "", value: { name: "Two" }, context: SELF });
    assert.deepEqual(
      h.samples.map((s) => (s.kind === "string" ? s.value : undefined)),
      ["One", "Two"],
    );
  });

  it("shares the name window with a data path named name", () => {
    const h = harness({});
    h.handle({ path: "name", value: "data", context: SELF });
    h.handle({ path: "", value: { name: "Sea Breeze" }, context: SELF });
    assert.equal(h.samples.length, 1);
  });
});

describe("routing by kind", () => {
  const one = (delta: DeltaLike): Sample[] => {
    const h = harness({});
    h.handle({ context: SELF, ...delta });
    return h.samples;
  };

  it("a finite number is a numeric row", () => {
    assert.deepEqual(one({ path: "environment.depth.belowKeel", value: 4.2 }), [
      {
        kind: "numeric",
        path: "environment.depth.belowKeel",
        context: "self",
        source: undefined,
        value: 4.2,
      },
    ]);
  });

  it("true is a tagged text row", () => {
    const samples = one({
      path: "watermaker.brineomatic.high_pressure_pump_on",
      value: true,
    });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].kind, "string");
    assert.equal((samples[0] as { value: string }).value, "true");
    assert.equal((samples[0] as { valueKind?: string }).valueKind, "boolean");
  });

  it("false is a tagged text row", () => {
    const samples = one({
      path: "electrical.switches.bilgePump.state",
      value: false,
    });
    assert.equal((samples[0] as { value: string }).value, "false");
    assert.equal((samples[0] as { valueKind?: string }).valueKind, "boolean");
  });

  it("a string is an untagged text row", () => {
    const samples = one({ path: "navigation.state", value: "anchored" });
    assert.equal((samples[0] as { value: string }).value, "anchored");
    assert.equal((samples[0] as { valueKind?: string }).valueKind, undefined);
  });

  it("a string true stays a string", () => {
    const samples = one({ path: "some.text", value: "true" });
    assert.equal((samples[0] as { valueKind?: string }).valueKind, undefined);
  });

  it("a complete navigation.position is a track row", () => {
    assert.deepEqual(
      one({
        path: "navigation.position",
        value: { latitude: 52.5, longitude: 13.4 },
      }),
      [
        {
          kind: "position",
          context: "self",
          source: undefined,
          latitude: 52.5,
          longitude: 13.4,
        },
      ],
    );
  });

  for (const path of [
    "navigation.anchor.position",
    "navigation.courseGreatCircle.nextPoint.position",
    "steering.autopilot.target.position",
  ]) {
    it(`a position under ${path} is flattened`, () => {
      const samples = one({
        path,
        value: { latitude: 12.05, longitude: -61.75 },
      });
      assert.deepEqual(
        samples.map((s) => [
          s.kind,
          "path" in s ? s.path : "",
          (s as { value: unknown }).value,
        ]),
        [
          ["numeric", `${path}.latitude`, 12.05],
          ["numeric", `${path}.longitude`, -61.75],
        ],
      );
    });
  }

  it("a half position is flattened", () => {
    assert.deepEqual(
      paths(one({ path: "navigation.position", value: { latitude: 1 } })),
      ["navigation.position.latitude"],
    );
  });

  it("an attitude object is flattened", () => {
    assert.deepEqual(
      one({ path: "navigation.attitude", value: { roll: 0.1, pitch: 0 } }).map(
        (s) => (s as { value: unknown }).value,
      ),
      [0.1, 0],
    );
  });

  it("a null position produces nothing", () => {
    assert.deepEqual(one({ path: "navigation.position", value: null }), []);
  });

  it("a NaN latitude drops that leaf only", () => {
    assert.deepEqual(
      paths(
        one({
          path: "navigation.position",
          value: { latitude: NaN, longitude: 13.4 },
        }),
      ),
      ["navigation.position.longitude"],
    );
  });

  it("a string latitude becomes a text leaf", () => {
    const samples = one({
      path: "navigation.position",
      value: { latitude: "52.5", longitude: 13.4 },
    });
    assert.deepEqual(
      samples.map((s) => [s.kind, "path" in s ? s.path : ""]),
      [
        ["string", "navigation.position.latitude"],
        ["numeric", "navigation.position.longitude"],
      ],
    );
    assert.equal((samples[0] as { valueKind?: string }).valueKind, undefined);
  });

  it("an infinite longitude drops that leaf only", () => {
    assert.deepEqual(
      paths(
        one({
          path: "navigation.position",
          value: { latitude: 52.5, longitude: Infinity },
        }),
      ),
      ["navigation.position.latitude"],
    );
  });

  for (const value of [NaN, Infinity, -Infinity]) {
    it(`${value} produces nothing`, () => {
      assert.deepEqual(one({ path: "environment.depth.belowKeel", value }), []);
    });
  }

  it("arrays produce nothing", () => {
    assert.deepEqual(one({ path: "some.list", value: [1, 2, 3] }), []);
    assert.deepEqual(one({ path: "some.list", value: [] }), []);
  });

  it("a non-finite value opens no sampling window", () => {
    const h = harness({});
    h.handle({ path: "a.b", value: NaN, context: SELF });
    h.handle({ path: "a.b", value: 1, context: SELF });
    assert.equal(h.samples.length, 1);
  });

  it("a delta without a string context throws a TypeError at emit", () => {
    const cfg = effectiveConfig({});
    const recorder = new Recorder({
      selfContext: SELF,
      recordSelf: cfg.recordSelf,
      recordOthers: cfg.recordOthers,
      filter: new PathFilter("exclude", []),
      sampling: new SamplingPolicy(2000, {}),
      gate: new SamplingGate(),
      emit: (sample) => {
        (sample.context as string).replace(",", "");
      },
    });
    assert.throws(() => recorder.handle({ path: "a.b", value: 1 }), TypeError);
    assert.doesNotThrow(() => recorder.handle({ path: "a.b", value: 1 }));
  });
});

describe("flattening objects", () => {
  const one = (stored: Record<string, unknown>, delta: DeltaLike): Sample[] => {
    const h = harness(stored);
    h.handle({ context: SELF, ...delta });
    return h.samples;
  };

  it("flattens three numeric leaves in key order", () => {
    const samples = one(
      {},
      {
        path: "navigation.attitude",
        value: { roll: 0.02, pitch: -0.01, yaw: 1.57 },
      },
    );
    assert.deepEqual(
      samples.map((s) => [
        "path" in s ? s.path : "",
        (s as { value: unknown }).value,
      ]),
      [
        ["navigation.attitude.roll", 0.02],
        ["navigation.attitude.pitch", -0.01],
        ["navigation.attitude.yaw", 1.57],
      ],
    );
  });

  it("routes mixed leaves by kind in key order", () => {
    const samples = one(
      {},
      {
        path: "some.thing",
        value: { count: 3, label: "port", active: true },
      },
    );
    assert.deepEqual(
      samples.map((s) => [
        s.kind,
        "path" in s ? s.path : "",
        (s as { value: unknown }).value,
        (s as { valueKind?: string }).valueKind,
      ]),
      [
        ["numeric", "some.thing.count", 3, undefined],
        ["string", "some.thing.label", "port", undefined],
        ["string", "some.thing.active", "true", "boolean"],
      ],
    );
  });

  it("drops non-finite leaves", () => {
    assert.deepEqual(
      paths(
        one(
          {},
          { path: "sensor.x", value: { good: 1.5, bad: NaN, worse: Infinity } },
        ),
      ),
      ["sensor.x.good"],
    );
  });

  it("drops nested objects and arrays", () => {
    assert.deepEqual(
      paths(
        one(
          {},
          {
            path: "a.b",
            value: { flat: 1, nested: { deep: 2 }, list: [1, 2] },
          },
        ),
      ),
      ["a.b.flat"],
    );
  });

  it("keeps the leaf with a value and skips null and undefined members", () => {
    assert.deepEqual(
      paths(
        one(
          {},
          {
            path: "a.b",
            value: { present: 1, empty: null, missing: undefined },
          },
        ),
      ),
      ["a.b.present"],
    );
  });

  it("an empty object produces nothing", () => {
    assert.deepEqual(one({}, { path: "a.b", value: {} }), []);
  });

  it("an array produces nothing", () => {
    assert.deepEqual(one({}, { path: "a.b", value: [1, 2] }), []);
  });

  it("flattens an anchor position in key order", () => {
    assert.deepEqual(
      paths(
        one(
          {},
          {
            path: "navigation.anchor.position",
            value: { latitude: 12.05, longitude: -61.75 },
          },
        ),
      ),
      [
        "navigation.anchor.position.latitude",
        "navigation.anchor.position.longitude",
      ],
    );
  });

  it("filters each leaf in include mode", () => {
    assert.deepEqual(
      paths(
        one(
          {
            pathFilter: {
              mode: "include",
              paths: ["navigation.attitude.roll"],
            },
          },
          { path: "navigation.attitude", value: { roll: 0.02, pitch: -0.01 } },
        ),
      ),
      ["navigation.attitude.roll"],
    );
  });

  it("a literal parent pattern excludes no leaf", () => {
    assert.deepEqual(
      paths(
        one(
          { pathFilter: { mode: "exclude", paths: ["navigation.attitude"] } },
          { path: "navigation.attitude", value: { roll: 0.02, pitch: -0.01 } },
        ),
      ),
      ["navigation.attitude.roll", "navigation.attitude.pitch"],
    );
  });

  it("leaves share windows with top-level deltas at the same path", () => {
    const h = harness({});
    h.handle({ path: "navigation.attitude.roll", value: 1, context: SELF });
    h.handle({
      path: "navigation.attitude",
      value: { roll: 2, pitch: 3 },
      context: SELF,
    });
    assert.deepEqual(paths(h.samples), [
      "navigation.attitude.roll",
      "navigation.attitude.pitch",
    ]);
  });
});
