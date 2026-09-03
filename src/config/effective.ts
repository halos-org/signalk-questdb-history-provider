/**
 * The values the plugin runs with, derived from whatever the server stored.
 * A missing or null key takes the schema default; any other stored value is
 * used as stored, wrong type included.
 */
export interface EffectiveConfig {
  questdbHost: string;
  questdbIlpPort: number;
  questdbHttpPort: number;
  pathFilter: { mode: unknown; paths: unknown };
  defaultSamplingRate: unknown;
  samplingRates: Record<string, unknown>;
  recordSelf: boolean;
  recordOthers: boolean;
  retentionDays: unknown;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_ILP_PORT = 9009;
export const DEFAULT_HTTP_PORT = 9000;
export const DEFAULT_SAMPLING_RATE = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function effectiveConfig(stored: unknown): EffectiveConfig {
  const c: Record<string, unknown> = isRecord(stored) ? stored : {};
  const filter = isRecord(c.pathFilter) ? c.pathFilter : {};
  return {
    questdbHost: (c.questdbHost ?? DEFAULT_HOST) as string,
    questdbIlpPort: (c.questdbIlpPort ?? DEFAULT_ILP_PORT) as number,
    questdbHttpPort: (c.questdbHttpPort ?? DEFAULT_HTTP_PORT) as number,
    pathFilter: {
      mode: filter.mode ?? "exclude",
      paths: filter.paths ?? [],
    },
    defaultSamplingRate: c.defaultSamplingRate ?? DEFAULT_SAMPLING_RATE,
    samplingRates: isRecord(c.samplingRates) ? c.samplingRates : {},
    recordSelf: c.recordSelf !== false,
    recordOthers: c.recordOthers !== false,
    retentionDays: c.retentionDays ?? 0,
  };
}
