import type { Sample } from "../ilp/line.js";
import type { PathFilter } from "./path-filter.js";
import type { SamplingGate, SamplingPolicy } from "./sampling.js";

export const SELF_CONTEXT = "self";
export const IDENTITY_PATH = "name";
export const POSITION_PATH = "navigation.position";

/** The delta fields this surface reads. Nothing else on the delta is looked at. */
export interface DeltaLike {
  path?: unknown;
  value?: unknown;
  context?: unknown;
  $source?: unknown;
}

export interface RecorderOptions {
  selfContext: string;
  recordSelf: boolean;
  recordOthers: boolean;
  filter: PathFilter;
  sampling: SamplingPolicy;
  gate: SamplingGate;
  emit: (sample: Sample) => void;
  now?: () => number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type Scalar =
  | { kind: "numeric"; value: number }
  | { kind: "string"; value: string }
  | { kind: "string"; value: string; valueKind: "boolean" };

const scalarOf = (value: unknown): Scalar | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { kind: "numeric", value } : undefined;
  }
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "boolean") {
    return { kind: "string", value: String(value), valueKind: "boolean" };
  }
  return undefined;
};

/**
 * Turns one server delta into zero or more samples: identity rows, scalar
 * rows, one track row for a complete `navigation.position`, or one row per
 * scalar leaf of any other object.
 */
export class Recorder {
  private readonly names = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now;
  }

  /** After the write buffer drops lines, every context's name is reported again. */
  forgetNames(): void {
    this.names.clear();
  }

  handle(delta: DeltaLike): void {
    const { path, value, context } = delta;
    const source =
      typeof delta.$source === "string" && delta.$source !== ""
        ? delta.$source
        : undefined;

    if (path === "" && isRecord(value) && isUsableName(value.name)) {
      this.identity(value.name, context, source);
      return;
    }
    if (typeof path !== "string" || path === "") return;
    if (value === null || value === undefined) return;

    if (this.discarded(context)) return;
    const stored = this.storedContext(context);

    const scalar = scalarOf(value);
    if (scalar) {
      this.record(path, scalar, stored, source);
      return;
    }
    if (!isRecord(value)) return;
    if (
      path === POSITION_PATH &&
      isFiniteNumber(value.latitude) &&
      isFiniteNumber(value.longitude)
    ) {
      if (!this.admits(path, stored)) return;
      this.options.emit({
        kind: "position",
        context: stored,
        source,
        latitude: value.latitude,
        longitude: value.longitude,
      });
      return;
    }
    for (const [key, leaf] of Object.entries(value)) {
      const leafScalar = scalarOf(leaf);
      if (leafScalar) this.record(`${path}.${key}`, leafScalar, stored, source);
    }
  }

  private identity(
    name: string,
    context: unknown,
    source: string | undefined,
  ): void {
    if (this.discarded(context)) return;
    const stored = this.storedContext(context);
    if (this.names.get(stored) === name) return;
    const rate = this.options.sampling.rateFor(IDENTITY_PATH);
    if (!this.options.gate.admit(IDENTITY_PATH, stored, rate, this.now())) {
      return;
    }
    this.names.set(stored, name);
    this.options.emit({
      kind: "string",
      path: IDENTITY_PATH,
      context: stored,
      source,
      value: name,
      valueKind: "identity",
    });
  }

  private record(
    path: string,
    scalar: Scalar,
    stored: string,
    source: string | undefined,
  ): void {
    if (!this.admits(path, stored)) return;
    this.options.emit({ ...scalar, path, context: stored, source });
  }

  private admits(path: string, stored: string): boolean {
    if (!this.options.filter.admits(path)) return false;
    const rate = this.options.sampling.rateFor(path);
    return this.options.gate.admit(path, stored, rate, this.now());
  }

  /**
   * `self` for the own vessel, the delta context verbatim otherwise. A
   * context that is not a string is not the own vessel and flows on as it
   * is.
   */
  private storedContext(context: unknown): string {
    return context === this.options.selfContext
      ? SELF_CONTEXT
      : (context as string);
  }

  private discarded(context: unknown): boolean {
    const isSelf = context === this.options.selfContext;
    return isSelf ? !this.options.recordSelf : !this.options.recordOthers;
  }
}

const isUsableName = (name: unknown): name is string =>
  typeof name === "string" && name.trim() !== "";

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
