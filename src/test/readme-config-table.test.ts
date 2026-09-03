// The README's configuration table against the schema it describes.
//
// The table repeats every default from src/config/schema.ts, which is the
// kind of copy that goes stale quietly: the schema changes, the Admin UI
// shows the new value, and the README keeps promising the old one to
// everyone reading it before they install. Deleting the defaults would fix
// the drift by making the README less useful, so pin them instead.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../config/schema.js";

const readme = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../README.md"),
  "utf8",
);

/**
 * The row label a reader sees, against the schema path it documents. This
 * map is the one hand-maintained part: a setting added to the schema and
 * not to the README fails below rather than going undocumented.
 */
const DOCUMENTED: Record<string, { key: string; uiTitle: string }> = {
  "QuestDB host": { key: "questdbHost", uiTitle: "QuestDB host" },
  "HTTP port": { key: "questdbHttpPort", uiTitle: "HTTP port (queries)" },
  "ILP port": { key: "questdbIlpPort", uiTitle: "ILP port (writes)" },
  "Sampling rate (ms)": {
    key: "defaultSamplingRate",
    uiTitle: "Default sampling rate (ms)",
  },
  "Record own vessel": { key: "recordSelf", uiTitle: "Record own vessel" },
  "Record other vessels": {
    key: "recordOthers",
    uiTitle: "Record other vessels",
  },
  "Retention (days)": {
    key: "retentionDays",
    uiTitle: "Retention (days, 0 = keep forever)",
  },
  "Path filter mode": { key: "pathFilter.mode", uiTitle: "Filter mode" },
  "Path filter paths": {
    key: "pathFilter.paths",
    uiTitle: "Path patterns (glob supported)",
  },
};

/** Per-path sampling overrides have no single default worth tabulating. */
const UNTABULATED = new Set(["samplingRates"]);

interface SchemaNode {
  default?: unknown;
  title?: string;
  properties?: Record<string, SchemaNode>;
}

const schemaNode = (dotted: string): SchemaNode => {
  let node = ConfigSchema as SchemaNode;
  for (const key of dotted.split(".")) {
    const child = node.properties?.[key];
    assert.ok(child, `schema has no ${dotted}`);
    node = child;
  }
  return node;
};

const schemaDefault = (dotted: string): unknown => schemaNode(dotted).default;

/** How a default is written in the table: `value`, or _(empty)_ for []. */
const rendered = (value: unknown): string =>
  Array.isArray(value) && value.length === 0
    ? "_(empty)_"
    : `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;

/**
 * Setting -> default cell, from the table under `## Configuration` only. The
 * README holds other tables (the schema's, the aggregate methods'); scoping to
 * this section is what lets the orphan check below assume every row it sees
 * ought to name a real setting.
 */
const tableRows = (): Map<string, string> => {
  const rows = new Map<string, string>();
  const section = readme.split("\n## Configuration\n")[1];
  assert.ok(section, "README has no ## Configuration section");
  for (const line of section.split("\n")) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells[0] === "Setting" || cells[0].startsWith("---")) continue;
    rows.set(cells[0], cells[1]);
  }
  return rows;
};

describe("README configuration table", () => {
  it("quotes the default each setting actually has", () => {
    const rows = tableRows();
    for (const [label, { key: dotted }] of Object.entries(DOCUMENTED)) {
      const documented = rows.get(label);
      assert.ok(documented, `README has no row for "${label}"`);
      assert.equal(
        documented,
        rendered(schemaDefault(dotted)),
        `README says ${label} defaults to ${documented}, schema says ` +
          `${rendered(schemaDefault(dotted))}`,
      );
    }
  });

  it("documents every setting the schema offers", () => {
    const documented = new Set(Object.values(DOCUMENTED).map((d) => d.key));
    const walk = (node: SchemaNode, prefix = ""): void => {
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const dotted = prefix + key;
        if (child.properties) {
          walk(child, `${dotted}.`);
          continue;
        }
        assert.ok(
          documented.has(dotted) || UNTABULATED.has(dotted),
          `${dotted} is a user-facing setting with no README row`,
        );
      }
    };
    walk(ConfigSchema as SchemaNode);
  });

  it("pins the Admin UI title each row stands for", () => {
    // The README shortens several titles on purpose ("ILP port" for "ILP port
    // (writes)"), so the two cannot be asserted equal. Pinning the title here
    // instead means renaming one in the schema fails this test, which is the
    // prompt to decide whether the README row should follow.
    for (const [label, { key, uiTitle }] of Object.entries(DOCUMENTED)) {
      assert.equal(
        schemaNode(key).title,
        uiTitle,
        `the Admin UI title for ${key} changed; check the README row "${label}"`,
      );
    }
  });

  it("has no row for a setting that no longer exists", () => {
    // The other direction, and the one a removal trips: deleting a field from
    // the schema leaves its row behind, still promising an option the Admin
    // UI does not offer. The two checks above only ever look outward from the
    // schema, so neither sees an orphan.
    const documented = new Set(Object.keys(DOCUMENTED));
    for (const label of tableRows().keys()) {
      assert.ok(
        documented.has(label),
        `README documents "${label}", which is not a setting`,
      );
    }
  });
});
