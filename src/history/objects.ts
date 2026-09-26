import type { QueryRows } from "../storage/sql-client.js";
import { fieldName, POINTER } from "../storage/pointer.js";

export type Column = Map<string, unknown>;
export type Fields = Record<string, unknown>;

export interface ObjectDelta {
  ts: string;
  fields: Fields;
}

export interface SampledRead {
  path: string;
  /** `<src>`: empty, or ` AND source = '<sourceRef>'`. */
  sourceClause: string;
  aggregate: "first" | "last";
  period: number;
}

export interface ObjectReader {
  /** Whether P has leaves in the request's range and context (Q10). */
  hasLeaves(path: string): Promise<boolean>;
  /** A downsampled object column; empty when P has no leaves or no rows. */
  sampled(read: SampledRead): Promise<Column>;
  /** The oldest `limit` deltas of P, in arrival order. */
  deltas(
    path: string,
    sourceClause: string,
    limit: number,
  ): Promise<ObjectDelta[]>;
}

export interface ObjectReaderOptions {
  query: QueryRows;
  /** W1 of the request. */
  contextWhere: string;
}

interface Leaves {
  numeric: string[];
  text: string[];
}

interface Candidate {
  ts: string;
  field: string;
  value: unknown;
  numeric: boolean;
}

interface LeafRow extends Candidate {
  source: string | null;
}

const NUMERIC_TABLE = "signalk";
const TEXT_TABLE = "signalk_str";
/** QuestDB's `ts` text, spliced into SQL only when it has exactly this form. */
const STORED_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Reads object-valued paths for one request. Leaf discovery (Q10) and each
 * table's bound (Q11) run at most once.
 */
export function createObjectReader(options: ObjectReaderOptions): ObjectReader {
  const { query, contextWhere } = options;
  let discovery: Promise<{ path: string; text: boolean }[]> | undefined;
  const bounds = new Map<string, Promise<string>>();

  /**
   * `<bnd>`: rows arrive in `ts` order and a table applies its commits in
   * order, so every delta before the newest visible `ts` is complete. The
   * newest one may not be: QuestDB can commit part of one ILP write.
   */
  const boundOf = (table: string): Promise<string> => {
    let bound = bounds.get(table);
    if (!bound) {
      bound = query(`SELECT max(ts) FROM ${table}`).then((rows) => {
        const cell = rows[0]?.[0];
        if (cell == null) return "";
        if (typeof cell !== "string" || !STORED_TS.test(cell)) {
          throw new Error(`Unreadable max(ts) of ${table}: ${String(cell)}`);
        }
        return ` AND ts < '${cell}'`;
      });
      bounds.set(table, bound);
    }
    return bound;
  };

  const discover = (): Promise<{ path: string; text: boolean }[]> =>
    (discovery ??= (async () => {
      const rows = await query(
        `SELECT DISTINCT path, '${NUMERIC_TABLE}' tbl FROM ${NUMERIC_TABLE} WHERE ${contextWhere} UNION SELECT DISTINCT path, '${TEXT_TABLE}' tbl FROM ${TEXT_TABLE} WHERE ${contextWhere}`,
      );
      return rows.map(([path, table]) => ({
        path: String(path),
        text: table === TEXT_TABLE,
      }));
    })());

  async function leavesOf(path: string): Promise<Leaves> {
    const prefix = `${path}${POINTER}`;
    const leaves: Leaves = { numeric: [], text: [] };
    for (const leaf of await discover()) {
      if (leaf.path.startsWith(prefix)) {
        (leaf.text ? leaves.text : leaves.numeric).push(leaf.path);
      }
    }
    return leaves;
  }

  /** W3: one leaf, bounded by its table's Q11. */
  const leafWhere = (
    name: string,
    sourceClause: string,
    bound: string,
  ): string =>
    `${contextWhere} AND path = ${literal(name)}${sourceClause}${bound}`;

  /** W4: every leaf of P in one table. */
  const leavesWhere = (
    names: string[],
    sourceClause: string,
    bound: string,
  ): string =>
    `${contextWhere} AND path IN (${names.map(literal).join(", ")})${sourceClause}${bound}`;

  async function sampled(read: SampledRead): Promise<Column> {
    const { path, sourceClause, aggregate, period } = read;
    const leaves = await leavesOf(path);
    if (leaves.numeric.length === 0 && leaves.text.length === 0) {
      return new Map();
    }
    const arrival = aggregate === "first" ? "min" : "max";
    const sample = `SAMPLE BY ${period}s ORDER BY ts`;
    const candidates = new Map<string, Candidate[]>();
    const addCandidate = (bucket: unknown, candidate: Candidate): void => {
      const list = candidates.get(String(bucket)) ?? [];
      list.push(candidate);
      candidates.set(String(bucket), list);
    };

    for (const leaf of leaves.numeric) {
      const field = fieldName(String(leaf));
      const bound = await boundOf(NUMERIC_TABLE);
      const rows = await query(
        `SELECT ts, ${aggregate}(value) value, ${arrival}(ts) arrival FROM ${NUMERIC_TABLE} WHERE ${leafWhere(leaf, sourceClause, bound)} ${sample}`,
      );
      for (const [bucket, value, at] of rows) {
        if (value == null) continue;
        addCandidate(bucket, { ts: String(at), field, value, numeric: true });
      }
    }
    for (const leaf of leaves.text) {
      const bound = await boundOf(TEXT_TABLE);
      const rows = await query(
        `SELECT ts, ${aggregate}(value_str) value_str, ${aggregate}(value_kind) value_kind, ${arrival}(ts) arrival FROM ${TEXT_TABLE} WHERE ${leafWhere(leaf, sourceClause, bound)} ${sample}`,
      );
      for (const [bucket, text, kind, at] of rows) {
        if (text == null) continue;
        addCandidate(bucket, {
          ts: String(at),
          field: fieldName(String(leaf)),
          value: decodeText(text, kind),
          numeric: false,
        });
      }
    }

    const direction = aggregate === "first" ? -1 : 1;
    const buckets = new Map<string, Fields>();
    for (const [bucket, list] of candidates) {
      const fields: Fields = {};
      const chosen = list.reduce((best, c) =>
        direction * compareTs(c.ts, best.ts) > 0 ? c : best,
      );
      for (const c of list) {
        if (c.ts === chosen.ts) setValue(fields, c);
      }
      buckets.set(bucket, fields);
    }
    return fillBuckets(buckets, period);
  }

  /** Q15 or Q16: the oldest leaf rows of one table, one past the row limit. */
  async function readLeaves(
    text: boolean,
    names: string[],
    sourceClause: string,
    limit: number,
  ): Promise<{ rows: LeafRow[]; truncated: boolean }> {
    const max = limit * names.length;
    const table = text ? TEXT_TABLE : NUMERIC_TABLE;
    const rows = await query(
      `SELECT ts, source, path, ${text ? "value_str, value_kind" : "value"} FROM ${table} WHERE ${leavesWhere(names, sourceClause, await boundOf(table))} ORDER BY ts LIMIT ${max + 1}`,
    );
    return {
      truncated: rows.length > max,
      rows: rows.map(([ts, source, leaf, value, kind]) => ({
        ts: String(ts),
        source: source == null ? null : String(source),
        field: fieldName(String(leaf)),
        value: text && value != null ? decodeText(value, kind) : value,
        numeric: !text,
      })),
    };
  }

  async function deltas(
    path: string,
    sourceClause: string,
    limit: number,
  ): Promise<ObjectDelta[]> {
    const leaves = await leavesOf(path);
    if (leaves.numeric.length === 0 && leaves.text.length === 0) return [];
    const reads = [];
    if (leaves.numeric.length > 0) {
      reads.push(await readLeaves(false, leaves.numeric, sourceClause, limit));
    }
    if (leaves.text.length > 0) {
      reads.push(await readLeaves(true, leaves.text, sourceClause, limit));
    }

    // A truncated read can end inside a delta; drop that delta and later ones.
    const cuts = reads
      .filter((r) => r.truncated)
      .map((r) => r.rows[r.rows.length - 1].ts);
    const all = reads
      .flatMap((r) => r.rows)
      .sort((a, b) => compareTs(a.ts, b.ts));
    const earliestCut = cuts.sort()[0];
    const kept =
      earliestCut === undefined ? all : all.filter((r) => r.ts < earliestCut);
    const rows = kept.length > 0 ? kept : all;

    const grouped = new Map<string, ObjectDelta>();
    for (const row of rows) {
      const id = JSON.stringify([row.ts, row.source]);
      let delta = grouped.get(id);
      if (!delta) {
        delta = { ts: row.ts, fields: {} };
        grouped.set(id, delta);
      }
      if (row.value != null) setValue(delta.fields, row);
    }
    return [...grouped.values()].slice(0, limit);
  }

  const hasLeaves = async (path: string): Promise<boolean> => {
    const leaves = await leavesOf(path);
    return leaves.numeric.length > 0 || leaves.text.length > 0;
  };

  return { hasLeaves, sampled, deltas };
}

/** A string literal with every `'` doubled. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A later value replaces an earlier one, but text never replaces a number. */
export function setValue(
  fields: Fields,
  c: Pick<Candidate, "field" | "value" | "numeric">,
): void {
  const current = Object.hasOwn(fields, c.field) ? fields[c.field] : undefined;
  if (c.numeric || typeof current !== "number") {
    defineField(fields, c.field, c.value);
  }
}

export function decodeText(text: unknown, kind: unknown): unknown {
  return kind === "boolean" ? text === "true" : text;
}

/** QuestDB `ts` strings share one fixed-width format, so text order is time order. */
function compareTs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Defines rather than assigns, so a stored key `__proto__` stays a field. */
function defineField(fields: Fields, name: string, value: unknown): void {
  Object.defineProperty(fields, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Fabricates the empty buckets `FILL(NULL)` would, epoch-aligned like `SAMPLE BY`. */
function fillBuckets(buckets: Map<string, Fields>, period: number): Column {
  const column: Column = new Map();
  const starts = [...buckets.keys()].sort();
  if (starts.length === 0) return column;
  const last = Date.parse(starts[starts.length - 1]);
  for (let t = Date.parse(starts[0]); t <= last; t += period * 1000) {
    const ts = new Date(t).toISOString().replace("Z", "000Z");
    column.set(ts, buckets.get(ts) ?? null);
  }
  return column;
}

/** Deltas sharing a timestamp keep the later one's value unless it is null. */
export function deltaColumn(
  deltas: ObjectDelta[],
  values: (Fields | null)[],
): Column {
  const column: Column = new Map();
  deltas.forEach((delta, i) => {
    if (values[i] !== null || !column.has(delta.ts)) {
      column.set(delta.ts, values[i]);
    }
  });
  return column;
}
