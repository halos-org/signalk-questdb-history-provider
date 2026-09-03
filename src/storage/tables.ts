import type { SqlExecutor } from "./sql-client.js";

export const TABLES = ["signalk", "signalk_str", "signalk_position"] as const;
export type Table = (typeof TABLES)[number];

export const CREATE_TABLE_STATEMENTS: Record<Table, string> = {
  signalk: `CREATE TABLE IF NOT EXISTS signalk (
  ts        TIMESTAMP,
  path      SYMBOL CAPACITY 512 CACHE,
  context   SYMBOL CAPACITY 128 CACHE,
  source    SYMBOL CAPACITY 256 CACHE,
  value     DOUBLE
) TIMESTAMP(ts)
  PARTITION BY DAY
  WAL
  DEDUP UPSERT KEYS(ts, path, context, source)`,
  signalk_str: `CREATE TABLE IF NOT EXISTS signalk_str (
  ts         TIMESTAMP,
  path       SYMBOL CAPACITY 256 CACHE,
  context    SYMBOL CAPACITY 128 CACHE,
  source     SYMBOL CAPACITY 256 CACHE,
  value_str  VARCHAR,
  value_kind SYMBOL CAPACITY 8 CACHE
) TIMESTAMP(ts)
  PARTITION BY DAY
  WAL
  DEDUP UPSERT KEYS(ts, path, context, source)`,
  signalk_position: `CREATE TABLE IF NOT EXISTS signalk_position (
  ts        TIMESTAMP,
  context   SYMBOL CAPACITY 128 CACHE,
  source    SYMBOL CAPACITY 256 CACHE,
  lat       DOUBLE,
  lon       DOUBLE
) TIMESTAMP(ts)
  PARTITION BY DAY
  WAL
  DEDUP UPSERT KEYS(ts, context, source)`,
};

export const DESIGNATED_TIMESTAMP = "ts";
export const KEEP_FOREVER_TTL = "0h";

export async function createTables(sql: SqlExecutor): Promise<void> {
  for (const table of TABLES) {
    await sql.query(CREATE_TABLE_STATEMENTS[table]);
  }
}

/** `N DAYS` for a positive whole number of days, `0h` for everything else. */
export function retentionTtl(retentionDays: unknown): string {
  const days = Math.max(0, Math.floor(Number(retentionDays)));
  return days >= 1 ? `${days} DAYS` : KEEP_FOREVER_TTL;
}

/** Sends the TTL statement to every owned table in order; throws on the first failure. */
export async function applyRetention(
  sql: SqlExecutor,
  ttl: string,
): Promise<void> {
  for (const table of TABLES) {
    await sql.query(`ALTER TABLE ${table} SET TTL ${ttl}`);
  }
}

export const introspectionQuery = (table: Table): string =>
  `SELECT "column" FROM table_columns('${table}') WHERE designated = true`;

/**
 * Rebuilds any owned table whose designated timestamp is not `ts`. That shape
 * appears when a write reaches QuestDB before the table exists: QuestDB then
 * creates it on its own with `timestamp` as the designated column, and no
 * query in this plugin can read it.
 *
 * `sql` is read for every statement. The lifecycle drops the client at stop,
 * and a pass that is in flight then fails at its next statement and ends.
 */
export async function repairSchema(
  sql: () => SqlExecutor,
  ttl: string,
  log: (message: string) => void,
): Promise<void> {
  for (const table of TABLES) {
    try {
      const designated = await designatedTimestamp(sql, table);
      if (designated === undefined || designated === DESIGNATED_TIMESTAMP) {
        continue;
      }
      await sql().query(`DROP TABLE IF EXISTS ${table}`);
      await createTables(sql());
      await applyRetention(sql(), ttl);
      log(`Rebuilt ${table}: ILP had auto-created it with a wrong schema`);
    } catch (error) {
      log(`schema heal check failed: ${errorMessage(error)}`);
      return;
    }
  }
}

async function designatedTimestamp(
  sql: () => SqlExecutor,
  table: Table,
): Promise<string | undefined> {
  const result = await sql()
    .query(introspectionQuery(table))
    .catch(() => undefined);
  const cell = result?.dataset[0]?.[0];
  return typeof cell === "string" ? cell : undefined;
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
