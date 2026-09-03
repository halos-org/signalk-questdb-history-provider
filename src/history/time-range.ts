import { Temporal } from "@js-temporal/polyfill";

export interface TimeRangeInput {
  from?: Temporal.Instant;
  to?: Temporal.Instant;
  duration?: Temporal.Duration | number;
}

export interface ResolvedRange {
  from: string;
  to: string;
}

export const INVALID_TIME_RANGE =
  "Invalid time range: provide at least from or duration";

/**
 * Turns the `from`, `to`, `duration` combination into two ISO 8601 instant
 * strings. A parameter is present when it is truthy, so a numeric duration
 * of 0 counts as absent while a zero-length Temporal.Duration counts as
 * present.
 */
export function resolveTimeRange(
  input: TimeRangeInput,
  now: () => Temporal.Instant = () => Temporal.Now.instant(),
): ResolvedRange {
  const current = now();
  const { from, to, duration } = input;
  const span =
    typeof duration === "number"
      ? Temporal.Duration.from({ seconds: duration })
      : duration;

  if (from && to) {
    return { from: from.toString(), to: to.toString() };
  }
  if (from && duration) {
    return { from: from.toString(), to: from.add(span!).toString() };
  }
  if (to && duration) {
    return { from: to.subtract(span!).toString(), to: to.toString() };
  }
  if (from) {
    return { from: from.toString(), to: current.toString() };
  }
  if (duration) {
    return { from: current.subtract(span!).toString(), to: current.toString() };
  }
  throw new Error(INVALID_TIME_RANGE);
}
