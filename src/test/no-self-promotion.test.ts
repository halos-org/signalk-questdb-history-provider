// The plugin must never ask the server to make it the default history
// provider. Where security is enabled the request is refused, and where it is
// disabled it overwrites the operator's chosen default on every restart. This
// asserts on the built artifact, which is what Signal K loads.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const distDir = path.join(repoRoot, "dist");

/** Every compiled runtime module, with whole-line comments removed.
 *
 * All of them, not just the entry point: `tsc` emits a file per source module
 * and `index.js` imports them, so a request moved into any sibling is invisible
 * to a scan of `index.js` alone. There are ~20.
 *
 * Only lines that are entirely a comment go. Cutting each line at `//` instead
 * would truncate `http://host/...` at the scheme and delete the very route this
 * file searches for — the assertion would then pass *because* the request is
 * there. A real call is never on a line that starts with `//`.
 */
function runtimeModules(): Array<{ name: string; code: string }> {
  const entries = readdirSync(distDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".js"))
    .filter((f) => !f.split(path.sep).includes("test"))
    .sort();

  // An empty or truncated list would pass every assertion below without
  // reading anything. The entry point is the one file guaranteed to exist.
  assert.ok(
    entries.includes("index.js"),
    `dist/ has no index.js (${entries.length} modules found) — run npm run build first`,
  );

  return entries.map((name) => ({
    name,
    code: readFileSync(path.join(distDir, name), "utf8")
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n"),
  }));
}

/** Modules whose code contains `literal`, by name. */
function modulesContaining(literal: string): string[] {
  return runtimeModules()
    .filter((m) => m.code.includes(literal))
    .map((m) => m.name);
}

describe("no self-promotion to default history provider", () => {
  it("no built module carries the default-provider route", () => {
    assert.deepEqual(
      modulesContaining("_providers/_default"),
      [],
      "a built module references the default-provider route. Setting the " +
        "default belongs to the operator.",
    );
  });

  it("no built module names the server's own v2 API", () => {
    // Broader than the route above, and the reason is the same: the plugin has
    // no credentials for its own HTTP API, so anything it calls there is
    // either refused or a write it should not be making. It reaches the server
    // through the object Signal K hands it, never over HTTP, so the string
    // should not appear at all.
    //
    // Not a loopback-address check. The plugin talks to QuestDB on 127.0.0.1
    // legitimately -- the health check curls it, and questdbHost defaults to
    // it -- so a rule about loopback would either miss the case that matters
    // or fail on traffic that is fine.
    assert.deepEqual(
      modulesContaining("/signalk/v2"),
      [],
      "a built module names the server's own v2 API; the plugin has no credentials for it.",
    );
  });
});

// Neither assertion can see a path assembled at runtime from pieces. That is
// the known floor of this check.
