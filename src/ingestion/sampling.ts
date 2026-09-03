import { Minimatch } from "minimatch";
import { isGlob } from "./path-filter.js";

export const SAMPLING_GATE_CAP = 10000;

/**
 * Resolves the minimum interval between writes for a path: an exact entry
 * wins, then the first matching glob in configuration order, then the
 * default. Entries whose rate is not greater than zero never match.
 */
export class SamplingPolicy {
  private readonly literals = new Map<string, number>();
  private readonly globs: { matcher: Minimatch; rate: number }[] = [];
  readonly defaultRate: number;

  constructor(
    defaultSamplingRate: unknown,
    samplingRates: Record<string, unknown>,
  ) {
    this.defaultRate = Number(defaultSamplingRate);
    for (const [pattern, stored] of Object.entries(samplingRates)) {
      const rate = Number(stored);
      if (!(rate > 0)) continue;
      if (isGlob(pattern)) {
        this.globs.push({ matcher: new Minimatch(pattern), rate });
      } else {
        this.literals.set(pattern, rate);
      }
    }
  }

  rateFor(path: string): number {
    const literal = this.literals.get(path);
    if (literal !== undefined) return literal;
    const glob = this.globs.find((g) => g.matcher.match(path));
    return glob ? glob.rate : this.defaultRate;
  }
}

/**
 * One window per (path, stored context) pair. A rejected update does not
 * extend the window; a rate that is not greater than zero admits everything.
 */
export class SamplingGate {
  private readonly lastAdmitted = new Map<string, number>();
  private largestRate = 0;

  constructor(private readonly cap: number = SAMPLING_GATE_CAP) {}

  admit(path: string, context: string, rate: number, now: number): boolean {
    if (!(rate > 0)) return true;
    this.largestRate = Math.max(this.largestRate, rate);
    const key = `${context}\n${path}`;
    const previous = this.lastAdmitted.get(key);
    if (previous !== undefined && now - previous < rate) return false;
    if (previous === undefined && this.lastAdmitted.size >= this.cap) {
      this.sweep(now);
    }
    this.lastAdmitted.set(key, now);
    return true;
  }

  clear(): void {
    this.lastAdmitted.clear();
  }

  private sweep(now: number): void {
    for (const [key, admitted] of this.lastAdmitted) {
      if (now - admitted >= this.largestRate) this.lastAdmitted.delete(key);
    }
    if (this.lastAdmitted.size >= this.cap) this.lastAdmitted.clear();
  }
}
