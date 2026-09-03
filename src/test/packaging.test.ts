// The packaging surface: the manifest, the tarball, and the entry point the
// server loads. Tarball checks read `npm pack --dry-run` because a file on
// disk is not evidence that the tarball carries it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

const UI_FRAMEWORKS_AND_BUNDLERS = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "preact",
  "webpack",
  "vite",
  "rollup",
  "esbuild",
  "parcel",
];

describe("package manifest and tarball", () => {
  let cache: string;
  let packed: string[];

  before(() => {
    cache = mkdtempSync(path.join(tmpdir(), "npm-cache-"));
    const output = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--offline", "--cache", cache],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(output) as { files: { path: string }[] }[];
    packed = parsed[0].files.map((f) => f.path);
  });

  after(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it("main names a file that exists", () => {
    assert.equal(manifest.main, "dist/index.js");
    assert.ok(existsSync(path.join(repoRoot, manifest.main)));
  });

  it("the tarball contains the main file", () => {
    assert.ok(packed.includes(manifest.main));
  });

  it("the tarball contains no path under src/", () => {
    assert.deepEqual(
      packed.filter((p) => p.startsWith("src/")),
      [],
    );
  });

  it("the tarball contains no browser bundle", () => {
    assert.deepEqual(
      packed.filter((p) => /\.bundle\.js$|^public\/.*\.js$/.test(p)),
      [],
    );
  });

  it("no dependency is a UI framework or a bundler", () => {
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    assert.deepEqual(
      names.filter((n) => UI_FRAMEWORKS_AND_BUNDLERS.includes(n)),
      [],
    );
  });

  it("type is module", () => {
    assert.equal(manifest.type, "module");
  });

  it("keywords mark a server plugin and nothing else", () => {
    assert.ok(manifest.keywords.includes("signalk-node-server-plugin"));
    assert.ok(!manifest.keywords.includes("signalk-plugin-configurator"));
    assert.ok(!manifest.keywords.includes("signalk-embeddable-webapp"));
  });

  it("requires no other Signal K plugin", () => {
    assert.equal(manifest.signalk.requires, undefined);
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    });
    assert.deepEqual(
      names.filter((n) => /^signalk-|^@signalk\/(?!server-api)/.test(n)),
      [],
    );
  });

  it("appIcon is a bare filename", () => {
    const icon = manifest.signalk.appIcon;
    assert.equal(typeof icon, "string");
    assert.ok(icon.length > 0);
    assert.ok(!icon.startsWith("./"));
    assert.ok(!icon.startsWith("/"));
  });

  it("public/<appIcon> exists on disk", () => {
    assert.ok(
      existsSync(path.join(repoRoot, "public", manifest.signalk.appIcon)),
    );
  });

  it("the tarball contains public/<appIcon>", () => {
    assert.ok(packed.includes(`public/${manifest.signalk.appIcon}`));
  });
});

describe("loading the entry point", () => {
  const require = createRequire(import.meta.url);
  const loaded = require(repoRoot);
  const factory = loaded.default ?? loaded;
  const minimalApp = {
    debug: () => undefined,
    error: () => undefined,
    setPluginStatus: () => undefined,
  };

  it("the default export is a function", () => {
    assert.equal(typeof factory, "function");
  });

  it("the factory builds the plugin from a minimal app object", () => {
    const plugin = factory(minimalApp);
    assert.equal(plugin.id, "signalk-questdb-history-provider");
    assert.equal(typeof plugin.name, "string");
    assert.equal(typeof plugin.start, "function");
    assert.equal(typeof plugin.stop, "function");
  });

  it("the schema is an object schema with the nine keys", () => {
    const plugin = factory(minimalApp);
    const schema =
      typeof plugin.schema === "function" ? plugin.schema() : plugin.schema;
    assert.equal(schema.type, "object");
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "defaultSamplingRate",
      "pathFilter",
      "questdbHost",
      "questdbHttpPort",
      "questdbIlpPort",
      "recordOthers",
      "recordSelf",
      "retentionDays",
      "samplingRates",
    ]);
  });

  it("dist/plugin-id.js exposes PLUGIN_ID without a server", () => {
    const { PLUGIN_ID } = require(path.join(repoRoot, "dist/plugin-id.js"));
    assert.equal(PLUGIN_ID, "signalk-questdb-history-provider");
  });
});
