// The rows marked _live_ in docs/spec/history-v2.md, against a real QuestDB 10.
// The unit suites script QuestDB's answers; these rows rest on what QuestDB
// itself does with the stored leaves: `last()` in scan order, `max(ts)` as the
// arrival key, keyed `SAMPLE BY`, and the Q11 bound under a concurrent write.
//
// Opt-in: runs only when QUESTDB_URL names an instance, for example
// `QUESTDB_URL=http://localhost:9000`. It drops and recreates the plugin's
// tables, so it refuses to start when they hold rows it did not write.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHistoryApiProvider } from "../history/v2.js";
import { SqlClient } from "../storage/sql-client.js";
import { TABLES, createTables, type Table } from "../storage/tables.js";
import type { history } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";

const QUESTDB_URL = process.env.QUESTDB_URL;
const CONTEXT = "live-test";
const MARKER = "live.marker";
const VISIBLE_TIMEOUT_MS = 10000;
const POLL_MS = 50;

interface Leaf {
  ts: string;
  path: string;
  source: string;
  value: number | string;
}

describe(
  "live QuestDB",
  { skip: QUESTDB_URL ? false : "QUESTDB_URL is not set" },
  () => {
    const sql = new SqlClient(QUESTDB_URL ?? "");
    const stored: Record<Table, number> = {
      signalk: 0,
      signalk_str: 0,
      signalk_position: 0,
    };

    // Set only once the guard has passed: node:test runs `after` hooks even
    // when `before` throws, and the teardown must not touch refused tables.
    let owned = false;

    async function drop(): Promise<void> {
      for (const table of TABLES) {
        await sql.query(`DROP TABLE IF EXISTS ${table}`);
        stored[table] = 0;
      }
    }

    before(async () => {
      await createTables(sql);
      for (const table of TABLES) {
        const [[foreign]] = await sql.rows(
          `SELECT count() FROM ${table} WHERE context IS NULL OR context != '${CONTEXT}'`,
        );
        if (Number(foreign) > 0) {
          throw new Error(
            `${table} holds rows the live suite did not write; point QUESTDB_URL at a throwaway QuestDB`,
          );
        }
      }
      owned = true;
      await drop();
      await createTables(sql);
    });

    // Dropped rather than emptied, so the plugin still creates its own tables
    // on the instance when the integration workflow starts it next.
    after(async () => {
      if (owned) await drop();
    });

    /** Inserts leaves, then waits until QuestDB has applied them. */
    async function store(table: Table, leaves: Leaf[]): Promise<void> {
      const column = table === "signalk" ? "value" : "value_str";
      const tuples = leaves.map(
        (l) =>
          `('${l.ts}', '${l.path}', '${CONTEXT}', '${l.source}', ${
            typeof l.value === "number" ? l.value : `'${l.value}'`
          })`,
      );
      await sql.query(
        `INSERT INTO ${table} (ts, path, context, source, ${column}) VALUES ${tuples.join(", ")}`,
      );
      stored[table] += leaves.length;
      const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
      for (;;) {
        const [[count]] = await sql.rows(`SELECT count() FROM ${table}`);
        if (Number(count) >= stored[table]) return;
        if (Date.now() > deadline) {
          throw new Error(
            `${table}: ${count} of ${stored[table]} rows applied`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }

    /** One delta: every field of an object path at one ts. */
    const delta = (
      path: string,
      ts: string,
      source: string,
      fields: Record<string, number | string>,
    ): Leaf[] =>
      Object.entries(fields).map(([key, value]) => ({
        ts,
        path: `${path}#/${key}`,
        source,
        value,
      }));

    /** A later row of another path, so Q11's bound lies past every delta. */
    const marker = (ts: string): Leaf => ({
      ts,
      path: MARKER,
      source: "marker",
      value: 0,
    });

    const provider = (query = sql.rows) =>
      createHistoryApiProvider({ selfContext: "vessels.self", query });

    const read = (
      hour: string,
      path: string,
      aggregate: string,
      query = sql.rows,
    ): Promise<history.ValuesResponse> =>
      provider(query).getValues({
        context: CONTEXT,
        from: Temporal.Instant.from(`2024-01-01T${hour}:00:00Z`),
        to: Temporal.Instant.from(`2024-01-01T${hour}:59:59Z`),
        resolution: 60,
        pathSpecs: [{ path, aggregate, parameter: [] }],
      } as unknown as history.ValuesRequest);

    // Every test reads its own hour and stores a marker after its deltas. The
    // tables are shared across tests, so a test reusing another's hour would
    // read that test's rows, and Q11 is table-wide: a marker must be the
    // newest row of its table when its test reads.
    const bucket = (hour: string): string => `2024-01-01T${hour}:00:00.000000Z`;
    const at = (hour: string, rest: string): string =>
      `2024-01-01T${hour}:00:${rest}Z`;
    const ATTITUDE = "navigation.attitude";

    it("keeps one read's fields to the deltas before Q11's bound while a delta lands", async () => {
      const h = "01";
      await store("signalk", [
        ...delta(ATTITUDE, at(h, "01.000000"), "a", {
          roll: 1,
          pitch: 1,
          yaw: 1,
        }),
        ...delta(ATTITUDE, at(h, "02.000000"), "a", {
          roll: 2,
          pitch: 2,
          yaw: 2,
        }),
        marker(at(h, "03.000000")),
      ]);
      let landed = false;
      const racing = async (statement: string): Promise<unknown[][]> => {
        const rows = await sql.rows(statement);
        // After the first leaf's Q13, whichever leaf QuestDB lists first.
        if (!landed && statement.includes("arrival")) {
          landed = true;
          await store(
            "signalk",
            delta(ATTITUDE, at(h, "04.000000"), "a", {
              roll: 3,
              pitch: 3,
              yaw: 3,
            }),
          );
        }
        return rows;
      };

      const r = await read(h, ATTITUDE, "last", racing);

      assert.ok(
        landed,
        "no leaf query matched 'arrival'; update the hook in racing()",
      );
      assert.deepEqual(r.data, [[bucket(h), { roll: 2, pitch: 2, yaw: 2 }]]);
    });

    it("takes the later delta whole, not the newest value of each field", async () => {
      const h = "02";
      await store("signalk", [
        ...delta(ATTITUDE, at(h, "01.000000"), "a", { roll: 1, pitch: 1 }),
        ...delta(ATTITUDE, at(h, "02.000000"), "a", { roll: 2 }),
        marker(at(h, "03.000000")),
      ]);

      const r = await read(h, ATTITUDE, "last");

      assert.deepEqual(r.data, [[bucket(h), { roll: 2 }]]);
    });

    it("orders two sources' deltas in one millisecond by arrival", async () => {
      const h = "03";
      await store("signalk", [
        ...delta(ATTITUDE, at(h, "01.000100"), "a", { roll: 1, pitch: 1 }),
        ...delta(ATTITUDE, at(h, "01.000200"), "b", { roll: 2 }),
        marker(at(h, "03.000000")),
      ]);

      assert.deepEqual((await read(h, ATTITUDE, "last")).data, [
        [bucket(h), { roll: 2 }],
      ]);
      assert.deepEqual((await read(h, ATTITUDE, "first")).data, [
        [bucket(h), { roll: 1, pitch: 1 }],
      ]);
    });

    it("takes the later of one source's two deltas in one millisecond", async () => {
      const h = "04";
      await store("signalk", [
        ...delta(ATTITUDE, at(h, "01.000100"), "a", { roll: 3 }),
        ...delta(ATTITUDE, at(h, "01.000200"), "a", { roll: 2 }),
        marker(at(h, "03.000000")),
      ]);

      assert.deepEqual((await read(h, ATTITUDE, "last")).data, [
        [bucket(h), { roll: 2 }],
      ]);
    });

    it("drops a field the later delta in one millisecond lacks", async () => {
      const h = "05";
      await store("signalk", [
        ...delta(ATTITUDE, at(h, "01.000100"), "a", { roll: 1, pitch: 1 }),
        ...delta(ATTITUDE, at(h, "01.000200"), "a", { roll: 2 }),
        marker(at(h, "03.000000")),
      ]);

      assert.deepEqual((await read(h, ATTITUDE, "last")).data, [
        [bucket(h), { roll: 2 }],
      ]);
    });

    it("reads a notification's text fields from one delta", async () => {
      const h = "06";
      const MOB = "notifications.mob";
      await store("signalk_str", [
        ...delta(MOB, at(h, "01.000000"), "a", {
          state: "alarm",
          message: "x",
        }),
        ...delta(MOB, at(h, "02.000000"), "a", {
          state: "normal",
          message: "y",
        }),
        { ...marker(at(h, "03.000000")), value: "marker" },
      ]);

      assert.deepEqual((await read(h, MOB, "last")).data, [
        [bucket(h), { state: "normal", message: "y" }],
      ]);
    });
  },
);
