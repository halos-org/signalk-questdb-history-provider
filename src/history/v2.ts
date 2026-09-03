import type { Temporal } from "@js-temporal/polyfill";
import type { history } from "@signalk/server-api";
import type { QueryRows } from "../storage/sql-client.js";
import { validateIdentifier, validateTimestamp } from "../storage/validate.js";
import { resolveTimeRange, type ResolvedRange } from "./time-range.js";

export const MAX_SAMPLE_BUCKETS = 1000000;
export const RAW_ROW_LIMIT = 10000;
export const CLIENT_AGGREGATE_ROW_LIMIT = 50000;
export const SMA_DEFAULT_WINDOW = 5;
export const EMA_DEFAULT_ALPHA = 0.2;

const POSITION_PATH = "navigation.position";
const SELF_ALIASES = new Set(["self", "vessels.self"]);
const CLIENT_SIDE_AGGREGATES = new Set(["sma", "ema", "middle_index"]);

const SQL_AGGREGATES: Record<string, string> = {
  average: "avg(value)",
  min: "min(value)",
  max: "max(value)",
  first: "first(value)",
  last: "last(value)",
  mid: "(min(value) + max(value)) / 2",
};

export interface HistoryApiProviderOptions {
  selfContext: string;
  query: QueryRows;
  now?: () => Temporal.Instant;
}

type Column = Map<string, unknown>;

interface ValueEntry {
  path: string;
  method: string;
  sourceRef?: string;
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

    const resolution = request.resolution;
    const sampled = typeof resolution === "number" && resolution > 0;
    const period = sampled ? Math.max(1, Math.floor(resolution)) : 0;

    const values: ValueEntry[] = [];
    const columns: Column[] = [];
    for (const spec of request.pathSpecs) {
      validateIdentifier(spec.path);
      const sourceRef = spec.sourceRef || undefined;
      if (sourceRef) validateIdentifier(sourceRef);
      const entry: ValueEntry = { path: spec.path, method: spec.aggregate };
      if (sourceRef) entry.sourceRef = sourceRef;
      const source = sourceRef ? ` AND source = '${sourceRef}'` : "";
      const contextWhere = `${rangeWhere(range)} AND context = '${storedContext}'`;

      let column: Column;
      if (spec.path === POSITION_PATH) {
        column = await positionColumn(`${contextWhere}${source}`, spec, period);
      } else if (CLIENT_SIDE_AGGREGATES.has(spec.aggregate)) {
        column = await clientSideColumn(
          `${contextWhere} AND path = '${spec.path}'${source}`,
          spec,
        );
      } else {
        column = await numericColumn(
          `${contextWhere} AND path = '${spec.path}'${source}`,
          spec,
          period,
          entry,
        );
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

  async function positionColumn(
    where: string,
    spec: history.PathSpec,
    period: number,
  ): Promise<Column> {
    const axis = spec.aggregate === "last" ? "last" : "first";
    const sql =
      period > 0
        ? `SELECT ts, ${axis}(lat) as lat, ${axis}(lon) as lon FROM signalk_position WHERE ${where} SAMPLE BY ${period}s FILL(NULL) ORDER BY ts`
        : `SELECT ts, lat, lon FROM signalk_position WHERE ${where} ORDER BY ts LIMIT ${RAW_ROW_LIMIT}`;
    const rows = await query(sql);
    const column: Column = new Map();
    for (const [ts, lat, lon] of rows) {
      column.set(
        String(ts),
        lat != null && lon != null ? { latitude: lat, longitude: lon } : null,
      );
    }
    return column;
  }

  async function clientSideColumn(
    where: string,
    spec: history.PathSpec,
  ): Promise<Column> {
    const rows = await query(
      `SELECT ts, value FROM signalk WHERE ${where} ORDER BY ts LIMIT ${CLIENT_AGGREGATE_ROW_LIMIT}`,
    );
    const series = rows.map(([ts, value]) => ({
      ts: String(ts),
      value: typeof value === "number" ? value : null,
    }));
    const parameter = Number(spec.parameter?.[0]);
    const computed =
      spec.aggregate === "sma"
        ? simpleMovingAverage(
            series.map((r) => r.value),
            parameter,
          )
        : spec.aggregate === "ema"
          ? exponentialMovingAverage(
              series.map((r) => r.value),
              parameter,
            )
          : middleIndex(series.map((r) => r.value));
    return new Map(series.map((r, i) => [r.ts, computed[i]]));
  }

  async function numericColumn(
    where: string,
    spec: history.PathSpec,
    period: number,
    entry: ValueEntry,
  ): Promise<Column> {
    const aggregate = SQL_AGGREGATES[spec.aggregate] ?? SQL_AGGREGATES.average;
    const numericSql =
      period > 0
        ? `SELECT ts, ${aggregate} as agg_value FROM signalk WHERE ${where} SAMPLE BY ${period}s FILL(NULL) ORDER BY ts`
        : `SELECT ts, value FROM signalk WHERE ${where} ORDER BY ts LIMIT ${RAW_ROW_LIMIT}`;
    const numericRows = await query(numericSql);
    if (numericRows.some(([, value]) => value != null)) {
      return new Map(numericRows.map(([ts, value]) => [String(ts), value]));
    }
    if (period > 0) entry.method = "last";
    const stringSql =
      period > 0
        ? `SELECT ts, last(value_str) as value_str, last(value_kind) as value_kind FROM signalk_str WHERE ${where} SAMPLE BY ${period}s FILL(NULL) ORDER BY ts`
        : `SELECT ts, value_str, value_kind FROM signalk_str WHERE ${where} ORDER BY ts LIMIT ${RAW_ROW_LIMIT}`;
    const stringRows = await query(stringSql);
    return new Map(
      stringRows.map(([ts, text, kind]) => [
        String(ts),
        kind === "boolean" ? text === "true" : text,
      ]),
    );
  }

  async function getPaths(
    request: history.PathsRequest,
  ): Promise<history.PathsResponse> {
    const where = rangeWhere(resolveTimeRange(request, now));
    const rows = await query(
      `SELECT DISTINCT path FROM signalk WHERE ${where} UNION SELECT DISTINCT path FROM signalk_str WHERE ${where} UNION SELECT DISTINCT 'navigation.position' path FROM signalk_position WHERE ${where} ORDER BY path`,
    );
    return rows.map((row) => String(row[0])) as history.PathsResponse;
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
    s.path === POSITION_PATH || !CLIENT_SIDE_AGGREGATES.has(s.aggregate);
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

export function middleIndex(values: (number | null)[]): (number | null)[] {
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
