// The configuration surface: the schema as emitted, and the effective value
// of every key when the stored object lacks it or holds something else.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../config/schema.js";
import { effectiveConfig } from "../config/effective.js";

const SPEC_SCHEMA = {
  type: "object",
  required: [
    "questdbHost",
    "questdbIlpPort",
    "questdbHttpPort",
    "pathFilter",
    "defaultSamplingRate",
    "samplingRates",
    "recordSelf",
    "recordOthers",
    "retentionDays",
  ],
  properties: {
    questdbHost: {
      type: "string",
      default: "127.0.0.1",
      title: "QuestDB host",
      description: "Hostname or address of the QuestDB server to connect to.",
    },
    questdbIlpPort: {
      type: "number",
      default: 9009,
      title: "ILP port (writes)",
      description:
        "QuestDB's line-protocol port. QuestDB's own default is 9009.",
    },
    questdbHttpPort: {
      type: "number",
      default: 9000,
      title: "HTTP port (queries)",
      description:
        "QuestDB's HTTP port, used for queries. Its default is 9000.",
    },
    pathFilter: {
      type: "object",
      required: ["mode", "paths"],
      properties: {
        mode: {
          anyOf: [
            { type: "string", const: "exclude" },
            { type: "string", const: "include" },
          ],
          default: "exclude",
          title: "Filter mode",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          default: [],
          title: "Path patterns (glob supported)",
          description: 'e.g. "notifications.*", "environment.wind.*"',
        },
      },
    },
    defaultSamplingRate: {
      type: "number",
      default: 2000,
      title: "Default sampling rate (ms)",
      description:
        "Minimum ms between writes for any path (0 = write every update). 2000ms is a sensible default for Pi-class hardware; lower it per-path via samplingRates when you need finer resolution.",
    },
    samplingRates: {
      type: "object",
      patternProperties: { "^.*$": { type: "number" } },
      default: {},
      title: "Per-path sampling rates (ms)",
      description:
        'Override default rate for specific paths. e.g. { "environment.wind.*": 200, "tanks.*": 10000 }',
    },
    recordSelf: { type: "boolean", default: true, title: "Record own vessel" },
    recordOthers: {
      type: "boolean",
      default: true,
      title: "Record other vessels",
    },
    retentionDays: {
      type: "number",
      default: 0,
      title: "Retention (days, 0 = keep forever)",
    },
  },
};

describe("schema", () => {
  it("is emitted exactly as specified, in property order", () => {
    assert.equal(JSON.stringify(ConfigSchema), JSON.stringify(SPEC_SCHEMA));
  });

  it("has no promoteToDefaultProvider property", () => {
    assert.ok(!("promoteToDefaultProvider" in ConfigSchema.properties));
  });
});

describe("effective values at start", () => {
  it("fills pathFilter and samplingRates when both are absent", () => {
    const cfg = effectiveConfig({ unknownKey: 1, recordSelf: true });
    assert.deepEqual(cfg.pathFilter, { mode: "exclude", paths: [] });
    assert.deepEqual(cfg.samplingRates, {});
    assert.equal(cfg.defaultSamplingRate, 2000);
  });

  it("completes pathFilter with mode only", () => {
    const cfg = effectiveConfig({ pathFilter: { mode: "include" } });
    assert.deepEqual(cfg.pathFilter, { mode: "include", paths: [] });
  });

  it("completes pathFilter with paths only", () => {
    const cfg = effectiveConfig({ pathFilter: { paths: ["navigation.*"] } });
    assert.deepEqual(cfg.pathFilter, {
      mode: "exclude",
      paths: ["navigation.*"],
    });
  });

  it("uses a full pathFilter and samplingRates as stored", () => {
    const cfg = effectiveConfig({
      pathFilter: { mode: "include", paths: ["navigation.*"] },
      samplingRates: { "environment.wind.*": 200 },
    });
    assert.deepEqual(cfg.pathFilter, {
      mode: "include",
      paths: ["navigation.*"],
    });
    assert.deepEqual(cfg.samplingRates, { "environment.wind.*": 200 });
  });

  it("does not rewrite the stored configuration", () => {
    const stored = { recordSelf: true };
    effectiveConfig(stored);
    assert.deepEqual(stored, { recordSelf: true });
    assert.deepEqual(effectiveConfig(stored).pathFilter, {
      mode: "exclude",
      paths: [],
    });
  });

  it("records self and others when the toggles are absent", () => {
    const cfg = effectiveConfig({ unknownKey: true });
    assert.equal(cfg.recordSelf, true);
    assert.equal(cfg.recordOthers, true);
  });

  it("keeps both toggles false", () => {
    const cfg = effectiveConfig({ recordSelf: false, recordOthers: false });
    assert.equal(cfg.recordSelf, false);
    assert.equal(cfg.recordOthers, false);
  });

  it("uses every other stored value verbatim, empty host included", () => {
    const cfg = effectiveConfig({
      questdbHost: "",
      questdbIlpPort: "9009",
      defaultSamplingRate: "abc",
      retentionDays: "abc",
      recordSelf: "no",
    });
    assert.equal(cfg.questdbHost, "");
    assert.equal(cfg.questdbIlpPort, "9009");
    assert.equal(cfg.questdbHttpPort, 9000);
    assert.equal(cfg.recordSelf, true);
    assert.equal(cfg.defaultSamplingRate, "abc");
    assert.equal(cfg.retentionDays, "abc");
  });

  it("treats null like a missing key", () => {
    const cfg = effectiveConfig({ questdbHost: null, pathFilter: null });
    assert.equal(cfg.questdbHost, "127.0.0.1");
    assert.deepEqual(cfg.pathFilter, { mode: "exclude", paths: [] });
  });
});
