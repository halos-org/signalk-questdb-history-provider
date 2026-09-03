import { Minimatch } from "minimatch";

const GLOB_CHARACTERS = /[*?[\]{}!+@()|]/;

/** A pattern with any glob metacharacter is a glob; anything else is a literal. */
export const isGlob = (pattern: string): boolean =>
  GLOB_CHARACTERS.test(pattern);

/**
 * The operator's path filter. A literal matches by exact equality; a glob
 * follows minimatch's default semantics. With no patterns every path is
 * recorded, whatever the mode.
 */
export class PathFilter {
  private readonly literals = new Set<string>();
  private readonly globs: Minimatch[] = [];
  private readonly exclude: boolean;

  constructor(mode: unknown, patterns: unknown) {
    this.exclude = mode === "exclude";
    for (const pattern of patterns as Iterable<string>) {
      if (isGlob(pattern)) {
        this.globs.push(new Minimatch(pattern));
      } else {
        this.literals.add(pattern);
      }
    }
  }

  get empty(): boolean {
    return this.literals.size === 0 && this.globs.length === 0;
  }

  matches(path: string): boolean {
    return this.literals.has(path) || this.globs.some((g) => g.match(path));
  }

  admits(path: string): boolean {
    if (this.empty) return true;
    return this.exclude ? !this.matches(path) : this.matches(path);
  }
}
