/**
 * One accepted sample, and its InfluxDB line protocol text.
 */
export type ValueKind = "boolean" | "identity";

export type Sample =
  | {
      kind: "numeric";
      path: string;
      context: string;
      source?: string;
      value: number;
    }
  | {
      kind: "string";
      path: string;
      context: string;
      source?: string;
      value: string;
      valueKind?: ValueKind;
    }
  | {
      kind: "position";
      context: string;
      source?: string;
      latitude: number;
      longitude: number;
    };

const NANOS_PER_MILLI = 1000000n;
const MIN_STEP_NANOS = 1000n;

/**
 * Assigns nanosecond timestamps that strictly increase by at least one
 * microsecond, so rows written in the same millisecond stay distinct at
 * QuestDB's microsecond storage resolution.
 */
export class IlpTimestamps {
  private last = 0n;

  next(nowMs: number = Date.now()): bigint {
    let ts = BigInt(nowMs) * NANOS_PER_MILLI;
    if (ts <= this.last) {
      ts = this.last + MIN_STEP_NANOS;
    }
    this.last = ts;
    return ts;
  }
}

const escapeTag = (value: string): string =>
  value.replace(/[,= \n\\]/g, (c) => `\\${c}`);

const escapeField = (value: string): string =>
  value.replace(/["\\]/g, (c) => `\\${c}`);

const sourceTag = (source: string | undefined): string =>
  source ? `,source=${escapeTag(source)}` : "";

export function encodeSample(sample: Sample, ts: bigint): string {
  const context = `context=${escapeTag(sample.context)}`;
  switch (sample.kind) {
    case "numeric":
      return `signalk,path=${escapeTag(sample.path)},${context}${sourceTag(sample.source)} value=${sample.value} ${ts}\n`;
    case "string": {
      const kind = sample.valueKind
        ? `,value_kind=${escapeTag(sample.valueKind)}`
        : "";
      return `signalk_str,path=${escapeTag(sample.path)},${context}${sourceTag(sample.source)}${kind} value_str="${escapeField(sample.value)}" ${ts}\n`;
    }
    case "position":
      return `signalk_position,${context}${sourceTag(sample.source)} lat=${sample.latitude},lon=${sample.longitude} ${ts}\n`;
  }
}
