// The storage surface: validators, DDL, retention, schema repair, and the
// HTTP transport's headers.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { validateIdentifier, validateTimestamp } from "../storage/validate.js";
import {
  applyRetention,
  createTables,
  repairSchema,
  retentionTtl,
} from "../storage/tables.js";
import { SqlClient, probeHealth } from "../storage/sql-client.js";
import {
  emptyResult,
  resultOf,
  scriptedSql,
  startFakeQuestDb,
  type FakeQuestDb,
} from "./helpers.js";

describe("identifier validation", () => {
  for (const value of [
    "navigation.speedOverGround",
    "self",
    "vessels.urn:mrn:imo:mmsi:123456789",
    "electrical.batteries.house_bank.voltage",
    "tanks.fuel.starboard_main.currentLevel",
  ]) {
    it(`accepts ${value}`, () => {
      assert.equal(validateIdentifier(value), value);
    });
  }

  for (const value of [
    "'; DROP TABLE signalk;--",
    "path OR 1=1",
    "path\nSELECT",
  ]) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.throws(() => validateIdentifier(value), {
        message: `Invalid identifier: ${value}`,
      });
    });
  }
});

describe("timestamp validation", () => {
  it("returns a full instant unchanged", () => {
    assert.equal(
      validateTimestamp("2024-06-15T12:00:00.000Z"),
      "2024-06-15T12:00:00.000Z",
    );
  });

  it("normalises a date", () => {
    assert.ok(validateTimestamp("2024-06-15").startsWith("2024-06-15"));
  });

  it("converts an offset to UTC", () => {
    assert.equal(
      validateTimestamp("2024-06-15T14:00:00+02:00"),
      "2024-06-15T12:00:00.000Z",
    );
  });

  it("rejects text that is not a date", () => {
    assert.throws(() => validateTimestamp("not-a-date"), {
      message: "Invalid timestamp: not-a-date",
    });
  });

  it("rejects the empty string", () => {
    assert.throws(() => validateTimestamp(""), {
      message: "Invalid timestamp: ",
    });
  });
});

describe("table creation", () => {
  it("sends the three DDL statements with their dedup keys", async () => {
    const sql = scriptedSql();
    await createTables(sql);
    assert.equal(sql.statements.length, 3);
    const [numeric, text, position] = sql.statements;
    assert.ok(numeric.includes("CREATE TABLE IF NOT EXISTS signalk ("));
    assert.ok(numeric.includes("DEDUP UPSERT KEYS(ts, path, context, source)"));
    assert.ok(text.includes("CREATE TABLE IF NOT EXISTS signalk_str ("));
    assert.ok(text.includes("DEDUP UPSERT KEYS(ts, path, context, source)"));
    assert.ok(
      position.includes("CREATE TABLE IF NOT EXISTS signalk_position ("),
    );
    assert.ok(position.includes("DEDUP UPSERT KEYS(ts, context, source)"));
  });

  it("gives signalk_str a value_kind column", async () => {
    const sql = scriptedSql();
    await createTables(sql);
    assert.ok(sql.statements[1].includes("value_kind"));
  });

  it("sends no ALTER TABLE", async () => {
    const sql = scriptedSql();
    await createTables(sql);
    assert.ok(sql.statements.every((s) => !s.includes("ALTER TABLE")));
  });
});

describe("retention", () => {
  it("sets 30 DAYS on every table in order", async () => {
    const sql = scriptedSql();
    await applyRetention(sql, retentionTtl(30));
    assert.deepEqual(sql.statements, [
      "ALTER TABLE signalk SET TTL 30 DAYS",
      "ALTER TABLE signalk_str SET TTL 30 DAYS",
      "ALTER TABLE signalk_position SET TTL 30 DAYS",
    ]);
  });

  it("sends 0h explicitly for 0", async () => {
    const sql = scriptedSql();
    await applyRetention(sql, retentionTtl(0));
    assert.deepEqual(sql.statements, [
      "ALTER TABLE signalk SET TTL 0h",
      "ALTER TABLE signalk_str SET TTL 0h",
      "ALTER TABLE signalk_position SET TTL 0h",
    ]);
  });

  it("floors 7.9 to 7 DAYS", async () => {
    const sql = scriptedSql();
    await applyRetention(sql, retentionTtl(7.9));
    assert.ok(sql.statements.every((s) => s.endsWith("SET TTL 7 DAYS")));
  });

  it("treats -1 as 0h", async () => {
    const sql = scriptedSql();
    await applyRetention(sql, retentionTtl(-1));
    assert.ok(sql.statements.every((s) => s.endsWith("SET TTL 0h")));
  });

  it("reads a numeric string as days and a non-numeric one as 0h", () => {
    assert.equal(retentionTtl("7"), "7 DAYS");
    assert.equal(retentionTtl("abc"), "0h");
    assert.equal(retentionTtl(undefined), "0h");
  });

  it("stops at the first failed statement", async () => {
    const sql = scriptedSql((s) =>
      s.includes("signalk_str") ? new Error("boom") : emptyResult,
    );
    await assert.rejects(applyRetention(sql, retentionTtl(1)), {
      message: "boom",
    });
    assert.equal(sql.statements.length, 2);
  });
});

const INTROSPECT = (table: string): string =>
  `SELECT "column" FROM table_columns('${table}') WHERE designated = true`;

describe("schema introspection and repair", () => {
  it("sends the quoted introspection query per table", async () => {
    const sql = scriptedSql();
    const log: string[] = [];
    await repairSchema(
      () => sql,
      "0h",
      (m) => log.push(m),
    );
    assert.deepEqual(sql.statements, [
      INTROSPECT("signalk"),
      INTROSPECT("signalk_str"),
      INTROSPECT("signalk_position"),
    ]);
    assert.ok(sql.statements.every((s) => !s.includes("SELECT column")));
    assert.deepEqual(log, []);
  });

  it("rebuilds nothing when every table answers ts", async () => {
    const sql = scriptedSql(() => resultOf([["ts"]]));
    const log: string[] = [];
    await repairSchema(
      () => sql,
      "0h",
      (m) => log.push(m),
    );
    assert.equal(sql.statements.length, 3);
    assert.ok(sql.statements.every((s) => !/DROP TABLE|CREATE TABLE/.test(s)));
    assert.deepEqual(log, []);
  });

  it("rebuilds nothing when introspection returns no rows", async () => {
    const sql = scriptedSql(() => emptyResult);
    const log: string[] = [];
    await repairSchema(
      () => sql,
      "0h",
      (m) => log.push(m),
    );
    assert.equal(sql.statements.length, 3);
    assert.deepEqual(log, []);
  });

  it("swallows an introspection failure and continues", async () => {
    const sql = scriptedSql((s) =>
      s.includes("'signalk'")
        ? new Error("table does not exist")
        : resultOf([["ts"]]),
    );
    const log: string[] = [];
    await repairSchema(
      () => sql,
      "0h",
      (m) => log.push(m),
    );
    assert.deepEqual(sql.statements, [
      INTROSPECT("signalk"),
      INTROSPECT("signalk_str"),
      INTROSPECT("signalk_position"),
    ]);
    assert.deepEqual(log, []);
  });

  it("drops and recreates a table whose designated timestamp is wrong", async () => {
    let first = true;
    const sql = scriptedSql((s) => {
      if (s === INTROSPECT("signalk") && first) {
        first = false;
        return resultOf([["timestamp"]]);
      }
      if (s.startsWith("SELECT")) return resultOf([["ts"]]);
      return emptyResult;
    });
    const log: string[] = [];
    await repairSchema(
      () => sql,
      "0h",
      (m) => log.push(m),
    );
    const after = sql.statements.slice(1);
    assert.equal(after[0], "DROP TABLE IF EXISTS signalk");
    assert.ok(after[1].includes("CREATE TABLE IF NOT EXISTS signalk ("));
    assert.ok(after[2].includes("CREATE TABLE IF NOT EXISTS signalk_str ("));
    assert.ok(
      after[3].includes("CREATE TABLE IF NOT EXISTS signalk_position ("),
    );
    assert.deepEqual(after.slice(4, 7), [
      "ALTER TABLE signalk SET TTL 0h",
      "ALTER TABLE signalk_str SET TTL 0h",
      "ALTER TABLE signalk_position SET TTL 0h",
    ]);
    assert.deepEqual(after.slice(7), [
      INTROSPECT("signalk_str"),
      INTROSPECT("signalk_position"),
    ]);
    assert.deepEqual(log, [
      "Rebuilt signalk: ILP had auto-created it with a wrong schema",
    ]);
  });

  it("re-applies the retention applied earlier in the start", async () => {
    const sql = scriptedSql((s) => {
      if (s === INTROSPECT("signalk")) return resultOf([["timestamp"]]);
      if (s.startsWith("SELECT")) return resultOf([["ts"]]);
      return emptyResult;
    });
    await repairSchema(
      () => sql,
      retentionTtl(30),
      () => undefined,
    );
    const ttl = sql.statements.filter((s) => s.includes("SET TTL"));
    assert.deepEqual(ttl, [
      "ALTER TABLE signalk SET TTL 30 DAYS",
      "ALTER TABLE signalk_str SET TTL 30 DAYS",
      "ALTER TABLE signalk_position SET TTL 30 DAYS",
    ]);
    const create = sql.statements.findIndex((s) =>
      s.includes("CREATE TABLE IF NOT EXISTS signalk "),
    );
    assert.ok(sql.statements.indexOf(ttl[0]) > create);
  });

  it("uses 0h before any retention application in the start", async () => {
    const sql = scriptedSql((s) => {
      if (s === INTROSPECT("signalk")) return resultOf([["timestamp"]]);
      if (s.startsWith("SELECT")) return resultOf([["ts"]]);
      return emptyResult;
    });
    await repairSchema(
      () => sql,
      "0h",
      () => undefined,
    );
    assert.deepEqual(
      sql.statements.filter((s) => s.includes("SET TTL")),
      [
        "ALTER TABLE signalk SET TTL 0h",
        "ALTER TABLE signalk_str SET TTL 0h",
        "ALTER TABLE signalk_position SET TTL 0h",
      ],
    );
  });

  it("stops the pass when a repair step throws", async () => {
    const sql = scriptedSql((s) => {
      if (s === INTROSPECT("signalk")) return resultOf([["timestamp"]]);
      if (s.startsWith("DROP TABLE")) return new Error("drop refused");
      return resultOf([["ts"]]);
    });
    const log: string[] = [];
    await repairSchema(
      () => sql,
      "0h",
      (m) => log.push(m),
    );
    assert.deepEqual(log, ["schema heal check failed: drop refused"]);
    assert.deepEqual(sql.statements, [
      INTROSPECT("signalk"),
      "DROP TABLE IF EXISTS signalk",
    ]);
  });
});

describe("HTTP transport", () => {
  let questdb: FakeQuestDb;

  before(async () => {
    questdb = await startFakeQuestDb((sql) =>
      sql === "SELECT 400" ? { status: 400, body: "bad query" } : emptyResult,
    );
  });

  after(async () => {
    await questdb.close();
  });

  it("sends Statement-Timeout 30000 with every statement", async () => {
    await new SqlClient(questdb.url).query("SELECT 1");
    assert.equal(questdb.queries.at(-1), "SELECT 1");
    assert.equal(questdb.headers.at(-1)?.["statement-timeout"], "30000");
  });

  it("fails a non-2xx answer with the status and body", async () => {
    await assert.rejects(new SqlClient(questdb.url).query("SELECT 400"), {
      message: "QuestDB query failed (400): bad query",
    });
  });

  it("probes health with a literal SELECT+1 and no Statement-Timeout", async () => {
    assert.equal(await probeHealth(questdb.url), true);
    assert.equal(questdb.queries.at(-1), "SELECT 1");
    assert.equal(questdb.headers.at(-1)?.["statement-timeout"], undefined);
  });

  it("answers false, never throws, when nothing listens", async () => {
    assert.equal(await probeHealth("http://127.0.0.1:1"), false);
  });
});
