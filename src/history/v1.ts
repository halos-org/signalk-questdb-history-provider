import type { QueryRows } from "../storage/sql-client.js";
import { errorMessage } from "../storage/tables.js";
import { fieldName, objectPathOf } from "../storage/pointer.js";
import { setValue, type Fields } from "./objects.js";

export const PLAYBACK_WINDOW_MS = 60000;
export const PAGE_LIMIT = 10000;
export const EMPTY_WINDOW_DELAY_MS = 100;
export const ERROR_RETRY_DELAY_MS = 1000;

const STORED_SELF = "self";
const IDENTITY_PATH = "name";

export interface PlaybackOptions {
  startTime: Date;
  playbackRate: number;
  subscribe?: string;
}

export interface PlaybackSocket {
  write(data: unknown): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
}

export interface DeltaUpdate {
  timestamp: string;
  $source?: string;
  values: { path: string; value: unknown }[];
}

export interface Delta {
  context: string;
  updates: [DeltaUpdate];
}

export interface PlaybackProvider {
  hasAnyData(
    options: PlaybackOptions,
    callback: (hasResults: boolean) => void,
  ): void;
  streamHistory(
    socket: PlaybackSocket,
    options: PlaybackOptions,
    onChange: () => void,
  ): () => void;
  getHistory(
    date: Date,
    path: string,
    callback: (deltas: Delta[]) => void,
  ): void;
}

export interface PlaybackProviderOptions {
  selfContext: string;
  query: QueryRows;
  debug: (message: string) => void;
}

const numericBranch = (where: string, tail = ""): string =>
  `SELECT ts, path, context, CAST(source AS STRING) source, CAST(value AS STRING) valuetext, 'number' kind FROM signalk WHERE ${where}${tail}`;
const stringBranch = (where: string, tail = ""): string =>
  `SELECT ts, path, context, CAST(source AS STRING) source, value_str valuetext, CAST(value_kind AS STRING) kind FROM signalk_str WHERE ${where}${tail}`;
const positionBranch = (where: string, tail = ""): string =>
  `SELECT ts, 'navigation.position' path, context, CAST(source AS STRING) source, concat(CAST(lat AS STRING), ',', CAST(lon AS STRING)) valuetext, 'position' kind FROM signalk_position WHERE ${where}${tail}`;

export const countSql = (start: string): string =>
  `SELECT sum(c) as cnt FROM (SELECT count() c FROM signalk WHERE ts >= '${start}' UNION ALL SELECT count() c FROM signalk_str WHERE ts >= '${start}' UNION ALL SELECT count() c FROM signalk_position WHERE ts >= '${start}')`;

export const windowSql = (from: string, to: string): string => {
  const where = `ts >= '${from}' AND ts < '${to}'`;
  return `${numericBranch(where)} UNION ALL ${stringBranch(where)} UNION ALL ${positionBranch(where)} ORDER BY ts LIMIT ${PAGE_LIMIT}`;
};

export const namesSql = (start: string): string =>
  `SELECT context, value_str FROM signalk_str WHERE path = 'name' AND value_kind = 'identity' AND ts <= '${start}' LATEST ON ts PARTITION BY context`;

export const snapshotSql = (at: string): string => {
  const where = `ts <= '${at}'`;
  const byPath = " LATEST ON ts PARTITION BY path, context";
  const byContext = " LATEST ON ts PARTITION BY context";
  return `(${numericBranch(where, byPath)}) UNION ALL (${stringBranch(where, byPath)}) UNION ALL (${positionBranch(where, byContext)})`;
};

/** Decodes `valuetext` per its stored kind tag into a delta value. */
export function decodeValue(text: unknown, kind: unknown): unknown {
  if (text === null || text === undefined) return null;
  switch (kind) {
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return text === "true";
    case "position": {
      const [latText, lonText] = String(text).split(",");
      const latitude = Number(latText);
      const longitude = Number(lonText);
      return Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : null;
    }
    default:
      return text;
  }
}

const storedContextOf = (context: unknown): string =>
  context === null || context === undefined || context === ""
    ? STORED_SELF
    : String(context);

const millisecondOf = (ts: unknown): number => new Date(String(ts)).getTime();

interface Group {
  delta: Delta;
  objects: Map<string, Fields>;
}

/**
 * Groups rows by (ts, context, source) into deltas, in order of first
 * appearance, with the pointer rows of one object path merged into one
 * object value.
 */
export function groupRows(rows: unknown[][]): Delta[] {
  const byKey = new Map<string, Map<string, Group>>();
  for (const [ts, path, context, source, text, kind] of rows) {
    const objectPath = objectPathOf(String(path));
    const timestamp = String(ts);
    const storedContext = storedContextOf(context);
    const sourceRef = typeof source === "string" ? source : undefined;
    const groupKey = `${storedContext}\n${sourceRef === undefined ? "\0" : `s:${sourceRef}`}`;

    let groups = byKey.get(timestamp);
    if (!groups) {
      groups = new Map();
      byKey.set(timestamp, groups);
    }
    let group = groups.get(groupKey);
    if (!group) {
      const update: DeltaUpdate = { timestamp, values: [] };
      if (sourceRef !== undefined) update.$source = sourceRef;
      group = {
        delta: { context: storedContext, updates: [update] },
        objects: new Map(),
      };
      groups.set(groupKey, group);
    }
    const values = group.delta.updates[0].values;
    const value = decodeValue(text, kind);
    if (objectPath === null) {
      values.push(
        path === IDENTITY_PATH &&
          kind === "identity" &&
          typeof value === "string"
          ? { path: "", value: { name: value } }
          : { path: String(path), value },
      );
      continue;
    }
    let fields = group.objects.get(objectPath);
    if (!fields) {
      fields = {};
      group.objects.set(objectPath, fields);
      values.push({ path: objectPath, value: fields });
    }
    if (value !== null) {
      setValue(fields, {
        field: fieldName(String(path)),
        value,
        numeric: kind === "number",
      });
    }
  }
  const deltas: Delta[] = [];
  for (const groups of byKey.values()) {
    for (const group of groups.values()) deltas.push(group.delta);
  }
  return deltas;
}

/**
 * Gives every pointer row of one object path and context the ts and source
 * of its newest row, so grouping merges the snapshot's latest leaves into
 * one object.
 */
function stampObjects(rows: unknown[][]): unknown[][] {
  const stamps = new Map<string, { ts: string; source: unknown }>();
  const stampKey = (path: unknown, context: unknown): string | null => {
    const objectPath = objectPathOf(String(path));
    return objectPath === null
      ? null
      : JSON.stringify([objectPath, storedContextOf(context)]);
  };
  for (const [ts, path, context, source] of rows) {
    const key = stampKey(path, context);
    if (key === null) continue;
    const best = stamps.get(key);
    if (!best || String(ts) > best.ts)
      stamps.set(key, { ts: String(ts), source });
  }
  return rows.map((row) => {
    const key = stampKey(row[1], row[2]);
    const stamp = key === null ? undefined : stamps.get(key);
    return stamp === undefined
      ? row
      : [stamp.ts, row[1], row[2], stamp.source, row[4], row[5]];
  });
}

export function createPlaybackProvider(
  options: PlaybackProviderOptions,
): PlaybackProvider {
  const { selfContext, query, debug } = options;

  const hasAnyData: PlaybackProvider["hasAnyData"] = (opts, callback) => {
    const start = opts.startTime.toISOString();
    query(countSql(start)).then(
      (rows) => callback(Number(rows[0]?.[0]) > 0),
      () => callback(false),
    );
  };

  const getHistory: PlaybackProvider["getHistory"] = (
    date,
    _path,
    callback,
  ) => {
    const at = date.toISOString();
    query(snapshotSql(at)).then(
      (rows) => callback(groupRows(stampObjects(rows))),
      (error) => {
        debug(`getHistory error: ${errorMessage(error)}`);
        callback([]);
      },
    );
  };

  const streamHistory: PlaybackProvider["streamHistory"] = (socket, opts) => {
    const start = opts.startTime.toISOString();
    const rate = Math.max(1, opts.playbackRate);
    let cursor = new Date(opts.startTime.getTime());
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let names: Map<string, string> | null = null;
    const namesSent = new Set<string>();

    const stop = (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delayMs: number): void => {
      timer = setTimeout(readWindow, delayMs);
      timer.unref();
    };

    const lookupNames = async (): Promise<Map<string, string>> => {
      const found = new Map<string, string>();
      try {
        for (const [context, name] of await query(namesSql(start))) {
          if (typeof name === "string" && name !== "") {
            found.set(storedContextOf(context), name);
          }
        }
      } catch {
        return found;
      }
      return found;
    };

    const readWindow = async (): Promise<void> => {
      timer = null;
      const from = cursor.toISOString();
      const windowEnd = new Date(cursor.getTime() + PLAYBACK_WINDOW_MS);
      const to = windowEnd.toISOString();
      try {
        const rows = await query(windowSql(from, to));
        if (stopped) return;
        if (rows.length === 0) {
          cursor = windowEnd;
          schedule(EMPTY_WINDOW_DELAY_MS);
          return;
        }
        let page = rows;
        let resume = windowEnd.getTime();
        if (rows.length >= PAGE_LIMIT) {
          const lastMs = millisecondOf(rows[rows.length - 1][0]);
          const earlier = rows.filter((r) => millisecondOf(r[0]) < lastMs);
          if (earlier.length > 0) {
            page = earlier;
            resume = Math.min(lastMs, resume);
          } else {
            resume = Math.min(lastMs + 1, resume);
          }
        }
        const deltas = groupRows(page);
        if (names === null) {
          names = await lookupNames();
          if (stopped) return;
        }
        for (const delta of deltas) {
          if (stopped) return;
          const stored = delta.context;
          const context = stored === STORED_SELF ? selfContext : stored;
          const name = names.get(stored);
          if (name !== undefined && !namesSent.has(stored)) {
            namesSent.add(stored);
            socket.write({
              context,
              updates: [
                {
                  timestamp: delta.updates[0].timestamp,
                  values: [{ path: "", value: { name } }],
                },
              ],
            });
          }
          socket.write({ ...delta, context });
        }
        if (rows.length >= PAGE_LIMIT) {
          cursor = new Date(resume);
          schedule(0);
        } else {
          cursor = windowEnd;
          schedule(PLAYBACK_WINDOW_MS / rate);
        }
      } catch (error) {
        if (stopped) return;
        debug(`streamHistory error: ${errorMessage(error)}`);
        schedule(ERROR_RETRY_DELAY_MS);
      }
    };

    socket.on("end", stop);
    void readWindow();
    return stop;
  };

  return { hasAnyData, streamHistory, getHistory };
}
