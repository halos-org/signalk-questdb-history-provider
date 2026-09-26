import type { Temporal } from "@js-temporal/polyfill";
import type { history } from "@signalk/server-api";
import { objectPathOf } from "../storage/pointer.js";
import type { QueryRows } from "../storage/sql-client.js";
import { validateIdentifier, validateTimestamp } from "../storage/validate.js";
import {
  createObjectReader,
  decodeText,
  deltaColumn,
  literal,
  type Column,
  type ObjectReader,
} from "./objects.js";
import { resolveTimeRange, type ResolvedRange } from "./time-range.js";

export const MAX_SAMPLE_BUCKETS = 1000000;
export const RAW_ROW_LIMIT = 10000;
export const CLIENT_AGGREGATE_ROW_LIMIT = 50000;
export const SMA_DEFAULT_WINDOW = 5;
export const EMA_DEFAULT_ALPHA = 0.2;

const POSITION_PATH = "navigation.position";
const SELF_ALIASES = new Set(["self", "vessels.self"]);
const CLIENT_SIDE_AGGREGATES = new Set(["sma", "ema", "middle_index"]);
/** The aggregates that pick a recorded value rather than compute one. */
const SELECTING_AGGREGATES = new Set(["first", "last", "middle_index"]);

const SQL_AGGREGATES: Record<string, string> = {
  average: "avg(value)",
  min: "min(value)",
  max: "max(value)",
  first: "first(value)",
  last: "last(value)",
  mid: "(min(value) + max(value)) / 2",
};

const AGGREGATE_NAMES = [
  ...Object.keys(SQL_AGGREGATES),
  "middle_index",
  "sma",
  "ema",
];

export interface HistoryApiProviderOptions {
  selfContext: string;
  query: QueryRows;
  now?: () => Temporal.Instant;
}

interface ValueEntry {
  path: string;
  method: string;
  $source?: string;
}

/**
 * One column to read. `stored` is set on a column expanded from a source by
 * the source policy: the stored source, or null for rows stored without one.
 */
interface ColumnSpec {
  spec: history.PathSpec;
  stored?: string | null;
}

/**
 * A scalar column. `empty` is true when neither the numeric read nor the text
 * read or probe found a row of the path, so it may be read as an object.
 */
interface ScalarColumn {
  column: Column;
  empty: boolean;
}

export function createHistoryApiProvider(
  options: HistoryApiProviderOptions,
): history.HistoryProvider {
  const { selfContext, query, now } = options;

  const rangeWhere = (range: ResolvedRange): string =>
    `ts >= '${validateTimestamp(range.from)}' AND ts <= '${validateTimestamp(range.to)}'`;

  async function getValues(
    request: history.ValuesRequest,
  ): Promise<history.ValuesResponse> {
    const range = resolveTimeRange(request, now);
    guardSampleBuckets(request.pathSpecs, request.resolution, range);

    const requestedContext = request.context ?? "vessels.self";
    const storedContext =
      SELF_ALIASES.has(requestedContext) || requestedContext === selfContext
        ? "self"
        : requestedContext;
    validateIdentifier(storedContext);
    const contextWhere = `${rangeWhere(range)} AND context = '${storedContext}'`;

    let columnSpecs: ColumnSpec[] = request.pathSpecs.map((spec) => ({ spec }));
    if (request.sourcePolicy === "all") {
      columnSpecs = await expandSources(request.pathSpecs, contextWhere);
      guardSampleBuckets(
        columnSpecs.map((c) => c.spec),
        request.resolution,
        range,
      );
    }

    const resolution = request.resolution;
    const sampled = typeof resolution === "number" && resolution > 0;
    const period = sampled ? Math.max(1, Math.floor(resolution)) : 0;
    let objects: ObjectReader | undefined;

    const values: ValueEntry[] = [];
    const columns: Column[] = [];
    for (const { spec, stored } of columnSpecs) {
      validateIdentifier(spec.path);
      if (!AGGREGATE_NAMES.includes(spec.aggregate)) {
        throw new Error(
          `Unknown aggregate ${spec.aggregate}: use average, min, max, first, last, mid, middle_index, sma or ema`,
        );
      }
      const entry: ValueEntry = { path: spec.path, method: spec.aggregate };
      let source = "";
      if (stored === undefined) {
        const sourceRef = spec.sourceRef || undefined;
        if (sourceRef) {
          validateIdentifier(sourceRef);
          entry.$source = sourceRef;
          source = ` AND source = '${sourceRef}'`;
        }
      } else if (stored === null) {
        source = " AND source IS NULL";
      } else {
        entry.$source = stored;
        source = ` AND source = ${literal(stored)}`;
      }
      const pathWhere = `${contextWhere} AND path = '${spec.path}'${source}`;

      let column: Column;
      if (spec.path === POSITION_PATH) {
        column = await positionColumn(`${contextWhere}${source}`, spec, period);
      } else {
        const client = CLIENT_SIDE_AGGREGATES.has(spec.aggregate);
        const scalar = client
          ? await clientSideColumn(pathWhere, spec)
          : await numericColumn(pathWhere, spec, period);
        column = scalar.column;
        if (scalar.empty) {
          objects ??= createObjectReader({ query, contextWhere });
          const read = await objectColumn(objects, spec, source, period);
          if (read.size > 0) column = read;
        }
      }
      values.push(entry);
      columns.push(column);
    }

    return {
      context: requestedContext,
      range,
      values,
      data: assembleRows(columns),
    } as history.ValuesResponse;
  }

  /**
   * Replaces each specification without a sourceRef by one per source with
   * rows of its path, ordered by source, the rows without a source last.
   */
  async function expandSources(
    specs: history.PathSpec[],
    contextWhere: string,
  ): Promise<ColumnSpec[]> {
    let pathSources: Map<string, Set<string | null>> | undefined;
    let positionSources: Set<string | null> | undefined;
    const expanded: ColumnSpec[] = [];
    for (const spec of specs) {
      if (spec.sourceRef) {
        expanded.push({ spec });
        continue;
      }
      let sources: Set<string | null> | undefined;
      if (spec.path === POSITION_PATH) {
        positionSources ??= new Set(
          (
            await query(
              `SELECT DISTINCT source FROM signalk_position WHERE ${contextWhere}`,
            )
          ).map(([source]) => storedSource(source)),
        );
        sources = positionSources;
      } else {
        pathSources ??= await sourcesByPath(contextWhere);
        sources = pathSources.get(spec.path);
      }
      for (const stored of orderSources(sources ?? new Set())) {
        expanded.push({ spec, stored });
      }
    }
    return expanded;
  }

  /** Q18: the sources of every path, an object's leaves under its own path. */
  async function sourcesByPath(
    contextWhere: string,
  ): Promise<Map<string, Set<string | null>>> {
    const rows = await query(
      `SELECT DISTINCT path, source FROM signalk WHERE ${contextWhere} UNION SELECT DISTINCT path, source FROM signalk_str WHERE ${contextWhere}`,
    );
    const byPath = new Map<string, Set<string | null>>();
    for (const [name, source] of rows) {
      const path = objectPathOf(String(name)) ?? String(name);
      const sources = byPath.get(path) ?? new Set();
      sources.add(storedSource(source));
      byPath.set(path, sources);
    }
    return byPath;
  }

  async function positionColumn(
    where: string,
    spec: history.PathSpec,
    period: number,
  ): Promise<Column> {
    const { aggregate } = spec;
    if (
      aggregate === "sma" ||
      aggregate === "ema" ||
      (period > 0 && !SELECTING_AGGREGATES.has(aggregate))
    ) {
      throw new Error(
        `Aggregate ${aggregate} does not apply to position path ${POSITION_PATH}: use first, last or middle_index`,
      );
    }
    const sql =
      aggregate === "middle_index"
        ? `SELECT ts, lat, lon FROM signalk_position WHERE ${where} ORDER BY ts LIMIT ${CLIENT_AGGREGATE_ROW_LIMIT}`
        : period > 0
          ? `SELECT ts, ${aggregate}(lat) as lat, ${aggregate}(lon) as lon FROM signalk_position WHERE ${where} SAMPLE BY ${period}s FILL(NULL) ORDER BY ts`
          : `SELECT ts, lat, lon FROM signalk_position WHERE ${where} ORDER BY ts LIMIT ${RAW_ROW_LIMIT}`;
    const rows = await query(sql);
    const fixes = rows.map(([ts, lat, lon]) => ({
      ts: String(ts),
      value:
        lat != null && lon != null ? { latitude: lat, longitude: lon } : null,
    }));
    return keyedColumn(fixes, aggregate === "middle_index");
  }

  async function clientSideColumn(
    where: string,
    spec: history.PathSpec,
  ): Promise<ScalarColumn> {
    const rows = await query(
      `SELECT ts, value FROM signalk WHERE ${where} ORDER BY ts LIMIT ${CLIENT_AGGREGATE_ROW_LIMIT}`,
    );
    if (rows.length === 0) {
      if (!(await hasText(where))) return { column: new Map(), empty: true };
      if (spec.aggregate !== "middle_index") throw textRefusal(spec);
      const text = await query(
        `SELECT ts, value_str, value_kind FROM signalk_str WHERE ${where} ORDER BY ts LIMIT ${CLIENT_AGGREGATE_ROW_LIMIT}`,
      );
      return {
        column: keyedColumn(
          text.map(([ts, value, kind]) => ({
            ts: String(ts),
            value: decodeText(value, kind),
          })),
          true,
        ),
        empty: false,
      };
    }
    const series = rows.map(([ts, value]) => ({
      ts: String(ts),
      value: typeof value === "number" ? value : null,
    }));
    const computed = smooth(
      spec,
      series.map((r) => r.value),
    );
    return {
      column: new Map(series.map((r, i) => [r.ts, computed[i]])),
      empty: false,
    };
  }

  async function numericColumn(
    where: string,
    spec: history.PathSpec,
    period: number,
  ): Promise<ScalarColumn> {
    const aggregate = SQL_AGGREGATES[spec.aggregate];
    const numericSql =
      period > 0
        ? `SELECT ts, ${aggregate} as agg_value FROM signalk WHERE ${where} SAMPLE BY ${period}s FILL(NULL) ORDER BY ts`
        : `SELECT ts, value FROM signalk WHERE ${where} ORDER BY ts LIMIT ${RAW_ROW_LIMIT}`;
    const numericRows = await query(numericSql);
    if (numericRows.some(([, value]) => value != null)) {
      return {
        column: new Map(numericRows.map(([ts, value]) => [String(ts), value])),
        empty: false,
      };
    }
    if (period > 0 && !SELECTING_AGGREGATES.has(spec.aggregate)) {
      if (await hasText(where)) throw textRefusal(spec);
      return { column: new Map(), empty: true };
    }
    const pick = spec.aggregate;
    const stringSql =
      period > 0
        ? `SELECT ts, ${pick}(value_str) as value_str, ${pick}(value_kind) as value_kind FROM signalk_str WHERE ${where} SAMPLE BY ${period}s FILL(NULL) ORDER BY ts`
        : `SELECT ts, value_str, value_kind FROM signalk_str WHERE ${where} ORDER BY ts LIMIT ${RAW_ROW_LIMIT}`;
    const stringRows = await query(stringSql);
    return {
      column: new Map(
        stringRows.map(([ts, text, kind]) => [
          String(ts),
          decodeText(text, kind),
        ]),
      ),
      empty: !stringRows.some(([, text]) => text != null),
    };
  }

  /** Q17: whether the path has scalar text rows. */
  async function hasText(where: string): Promise<boolean> {
    const rows = await query(
      `SELECT ts FROM signalk_str WHERE ${where} LIMIT 1`,
    );
    return rows.length > 0;
  }

  async function objectColumn(
    objects: ObjectReader,
    spec: history.PathSpec,
    sourceClause: string,
    period: number,
  ): Promise<Column> {
    if (!(await objects.hasLeaves(spec.path))) return new Map();
    const { aggregate } = spec;
    if (aggregate === "middle_index") {
      const deltas = await objects.deltas(
        spec.path,
        sourceClause,
        CLIENT_AGGREGATE_ROW_LIMIT,
      );
      return deltaColumn(deltas, middleIndex(deltas.map((d) => d.fields)));
    }
    const refuse = (): Error =>
      new Error(
        `Aggregate ${aggregate} does not apply to object path ${spec.path}: use first, last or middle_index`,
      );
    if (period > 0) {
      if (aggregate !== "first" && aggregate !== "last") throw refuse();
      return objects.sampled({
        path: spec.path,
        sourceClause,
        aggregate,
        period,
      });
    }
    if (aggregate === "sma" || aggregate === "ema") throw refuse();
    const deltas = await objects.deltas(spec.path, sourceClause, RAW_ROW_LIMIT);
    return deltaColumn(
      deltas,
      deltas.map((d) => d.fields),
    );
  }

  async function getPaths(
    request: history.PathsRequest,
  ): Promise<history.PathsResponse> {
    const where = rangeWhere(resolveTimeRange(request, now));
    const rows = await query(
      `SELECT DISTINCT path FROM signalk WHERE ${where} UNION SELECT DISTINCT path FROM signalk_str WHERE ${where} UNION SELECT DISTINCT 'navigation.position' path FROM signalk_position WHERE ${where} ORDER BY path`,
    );
    const paths = new Set(
      rows.map((row) => {
        const name = String(row[0]);
        return objectPathOf(name) ?? name;
      }),
    );
    return [...paths] as history.PathsResponse;
  }

  async function getContexts(
    request: history.ContextsRequest,
  ): Promise<history.ContextsResponse> {
    const where = rangeWhere(resolveTimeRange(request, now));
    const rows = await query(
      `SELECT DISTINCT context FROM signalk WHERE ${where} UNION SELECT DISTINCT context FROM signalk_str WHERE ${where} UNION SELECT DISTINCT context FROM signalk_position WHERE ${where} ORDER BY context`,
    );
    return rows.map((row) =>
      row[0] === "self" ? "vessels.self" : String(row[0]),
    ) as history.ContextsResponse;
  }

  return { getValues, getPaths, getContexts };
}

function guardSampleBuckets(
  specs: history.PathSpec[],
  resolution: number | undefined,
  range: ResolvedRange,
): void {
  const isSampled = (s: history.PathSpec): boolean =>
    !CLIENT_SIDE_AGGREGATES.has(s.aggregate);
  const isFallbackCapable = (s: history.PathSpec): boolean =>
    s.path !== POSITION_PATH && !CLIENT_SIDE_AGGREGATES.has(s.aggregate);
  const sampledCount = specs.filter(isSampled).length;
  const fallbackCount = specs.filter(isFallbackCapable).length;
  if (
    sampledCount === 0 ||
    typeof resolution !== "number" ||
    !(resolution > 0)
  ) {
    return;
  }
  const rangeSeconds = (Date.parse(range.to) - Date.parse(range.from)) / 1000;
  const effective = Math.max(1, Math.floor(resolution));
  const perSeries = Math.ceil(rangeSeconds / effective);
  const buckets = perSeries * (sampledCount + fallbackCount);
  if (buckets > MAX_SAMPLE_BUCKETS) {
    throw new Error(
      `resolution ${resolution}s over this range produces up to ${buckets} sample buckets across ${sampledCount} paths (max ${MAX_SAMPLE_BUCKETS}) — use a coarser resolution or a shorter range`,
    );
  }
}

function storedSource(source: unknown): string | null {
  return source == null ? null : String(source);
}

function orderSources(sources: Set<string | null>): (string | null)[] {
  const named = [...sources].filter((s): s is string => s !== null).sort();
  return sources.has(null) ? [...named, null] : named;
}

function textRefusal(spec: history.PathSpec): Error {
  return new Error(
    `Aggregate ${spec.aggregate} does not apply to text path ${spec.path}: use first, last or middle_index`,
  );
}

/** A column of rows in read order; `middle` keeps only the middle one. */
function keyedColumn(
  rows: { ts: string; value: unknown }[],
  middle: boolean,
): Column {
  const values = middle
    ? middleIndex(rows.map((r) => r.value))
    : rows.map((r) => r.value);
  return new Map(rows.map((r, i) => [r.ts, values[i]]));
}

function smooth(
  spec: history.PathSpec,
  values: (number | null)[],
): (number | null)[] {
  const parameter = Number(spec.parameter?.[0]);
  return spec.aggregate === "sma"
    ? simpleMovingAverage(values, parameter)
    : spec.aggregate === "ema"
      ? exponentialMovingAverage(values, parameter)
      : middleIndex(values);
}

export function simpleMovingAverage(
  values: (number | null)[],
  parameter: number,
): (number | null)[] {
  const window =
    Number.isInteger(parameter) && parameter >= 1
      ? parameter
      : SMA_DEFAULT_WINDOW;
  const recent: number[] = [];
  return values.map((value) => {
    if (value === null) return null;
    recent.push(value);
    if (recent.length > window) recent.shift();
    return recent.reduce((sum, v) => sum + v, 0) / recent.length;
  });
}

export function exponentialMovingAverage(
  values: (number | null)[],
  parameter: number,
): (number | null)[] {
  const alpha = parameter > 0 && parameter <= 1 ? parameter : EMA_DEFAULT_ALPHA;
  let smoothed: number | null = null;
  return values.map((value) => {
    if (value === null) return smoothed;
    smoothed =
      smoothed === null ? value : alpha * value + (1 - alpha) * smoothed;
    return smoothed;
  });
}

export function middleIndex<T>(values: (T | null)[]): (T | null)[] {
  const keep = Math.floor(values.length / 2);
  return values.map((value, i) => (i === keep ? value : null));
}

function assembleRows(columns: Column[]): [string, ...unknown[]][] {
  const timestamps = new Set<string>();
  for (const column of columns) {
    for (const ts of column.keys()) timestamps.add(ts);
  }
  return [...timestamps]
    .sort()
    .map((ts) => [ts, ...columns.map((column) => column.get(ts) ?? null)]);
}
