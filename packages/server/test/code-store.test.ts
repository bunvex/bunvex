// Deployed code in the store (STUDY-35 PR 2): `_source_packages`, `_modules`, `_udf_config`, the package in
// the modules store, and a deployable server loading the latest version on start.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine, MODULES_TABLE, SOURCE_PACKAGES_TABLE } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { LocalBlobStore, MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { readPackage, storedModules, udfConfig } from "../src/code-store.ts";
import { InvalidModulesError, type ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });
const app = (n: number, extra: ModuleSource[] = []) => [
  mod(
    "messages.js",
    `import { query, mutation } from "@bunvex/server";
     export const version = query(async () => ${n});
     export const rand = query(async () => 0);
     export const seeded = ${"Math.random()"};
     export const add = mutation(async ({ db }) => db.insert("items", {}));`,
  ),
  ...extra,
];

async function deployable(dir: string, moduleStorage = new LocalBlobStore(join(dir, "storage"), "modules")) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }),
  ).init();
  const s = createServer({ engine, functions: new Functions(engine), port: 0, deployable: true, moduleStorage });
  const call = async (path: string) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: {} }),
      })
    ).json()) as { value?: unknown; errorMessage?: string };
  return { engine, s, call, moduleStorage };
}

describe("deployed code in the store", () => {
  test("a deploy writes the package, the module rows and the udf config; the code is live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const d = await deployable(dir);
    stops.push(() => d.s.shutdown());
    await d.s.codeReady;
    expect((await d.call("messages:version")).errorMessage).toContain("Could not find public function");
    await d.s.deployCode(app(1));
    expect((await d.call("messages:version")).value).toBe(1);
    const stored = (await storedModules(d.engine))!;
    expect(stored.rows.map((r) => [r.path, r.environment, r.sha256.length])).toEqual([["messages.js", "isolate", 64]]);
    expect(stored.rows[0]!.analyzeResult!.functions.map((f) => f.name)).toEqual(["add", "rand", "version"]);
    expect(stored.pkg.packageSize.zippedSizeBytes).toBeGreaterThan(0n);
    expect((await readPackage(d.moduleStorage, stored.pkg.storageKey))[0]!.path).toBe("messages.js");
    // The package lives in the modules store, not with user files.
    expect(readdirSync(join(dir, "storage"))).toEqual(["modules"]);
    const config = await udfConfig(d.engine);
    expect(config.seed.length).toBe(8);
    expect(await udfConfig(d.engine)).toEqual(config); // made once
  });

  test("the package keeps each module's source and source map (Convex: test_source_package)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const d = await deployable(dir);
    stops.push(() => d.s.shutdown());
    await d.s.codeReady;
    const map = JSON.stringify({ version: 3, sources: ["../bunvex/b.ts"], mappings: "AAAA" });
    const withMap: ModuleSource = { ...mod("b.js", "export const b = 1;"), sourceMap: map };
    await d.s.deployCode(app(1, [withMap, mod("c.js", "export const c = 1;")]));
    const stored = (await storedModules(d.engine))!;
    const modules = await readPackage(d.moduleStorage, stored.pkg.storageKey);
    const byPath = new Map(modules.map((m) => [m.path, m]));
    expect(byPath.get("b.js")).toMatchObject({ source: "export const b = 1;", sourceMap: map });
    // A module without a map has none after the round trip either.
    expect(byPath.get("c.js")?.sourceMap).toBeUndefined();
  });

  test("a second deploy replaces the rows and deletes the unused package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const d = await deployable(dir);
    stops.push(() => d.s.shutdown());
    await d.s.deployCode(app(1, [mod("extra.js", `export const x = 1;`)]));
    const first = (await storedModules(d.engine))!.pkg;
    await d.s.deployCode(app(2));
    expect((await d.call("messages:version")).value).toBe(2);
    const stored = (await storedModules(d.engine))!;
    expect(stored.rows.map((r) => r.path)).toEqual(["messages.js"]);
    expect(stored.pkg._id).not.toBe(first._id);
    const packages = await d.engine.query((db) => db.asSystem(() => db.query(SOURCE_PACKAGES_TABLE).collect()));
    expect(packages.length).toBe(1);
    expect(await d.moduleStorage.get(first.storageKey)).toBeNull();
  });

  test("a deploy leaves the root component's rows as Convex's push does, once (STUDY-133 §12 M2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const d = await deployable(dir);
    stops.push(() => d.s.shutdown());
    const rows = () =>
      d.engine.query((db) =>
        db.asSystem(async () => ({
          definitions: await (db as any).query("_component_definitions").collect(),
          components: await (db as any).query("_components").collect(),
        })),
      ) as Promise<{ definitions: Record<string, unknown>[]; components: Record<string, unknown>[] }>;
    expect(await rows()).toEqual({ definitions: [], components: [] }); // none before a push, as Convex
    await d.s.deployCode(app(1));
    await d.s.deployCode(app(2));
    const { definitions, components } = await rows();
    expect(definitions).toEqual([
      expect.objectContaining({
        path: "",
        definitionType: { type: "app" },
        childComponents: [],
        httpMounts: {},
        httpPrefix: null,
        exports: { type: "branch", branch: [] },
        envVars: null,
      }),
    ]);
    expect(components).toEqual([
      expect.objectContaining({
        definitionId: definitions[0]!._id,
        parent: null,
        name: null,
        args: null,
        env: null,
        state: "active",
        httpPrefix: null,
      }),
    ]);
  });

  test("a deploy that fails to load changes nothing and leaves no package behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const d = await deployable(dir);
    stops.push(() => d.s.shutdown());
    await d.s.deployCode(app(1));
    const before = await storedModules(d.engine);
    const err = await d.s.deployCode([mod("messages.js", `throw new Error("broken");`)]).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidModulesError);
    expect((await d.call("messages:version")).value).toBe(1);
    expect(await storedModules(d.engine)).toEqual(before);
    const blobs: string[] = [];
    for await (const b of d.moduleStorage.list()) blobs.push(b.key);
    expect(blobs).toEqual([before!.pkg.storageKey]);
  });

  test("a deploy whose commit fails deletes the package it stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const d = await deployable(dir);
    stops.push(() => d.s.shutdown());
    await d.s.deployCode(app(1));
    const before = await storedModules(d.engine);
    // 12 000 functions: the module's row (its analysis) is over the document limits (8192 array items).
    const many = Array.from({ length: 12_000 }, (_, i) => `export const f${i} = query(async () => ${i});`).join("\n");
    const err = await d.s
      .deployCode([mod("big.js", `import { query } from "@bunvex/server";\n${many}`)])
      .catch((e) => e);
    expect(String(err)).toMatch(/too long|size|limit/i);
    expect(await storedModules(d.engine)).toEqual(before);
    const blobs: string[] = [];
    for await (const b of d.moduleStorage.list()) blobs.push(b.key);
    expect(blobs).toEqual([before!.pkg.storageKey]);
    expect((await d.call("messages:version")).value).toBe(1);
  });

  test("a deployable server restarts on the latest version, imported the same way (the udf config's seed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const a = await deployable(dir);
    await a.s.codeReady;
    const first = await a.s.deployCode(app(3));
    const seeded = (first.version.modules.get("messages.js")!.module.namespace as { seeded: number }).seeded;
    await a.s.shutdown();
    const b = await deployable(dir);
    stops.push(() => b.s.shutdown());
    await b.s.codeReady;
    expect((await b.call("messages:version")).value).toBe(3);
    const rows = await b.engine.query((db) => db.asSystem(() => db.query(MODULES_TABLE).collect()));
    expect(rows.length).toBe(1);
    // Same seed: the module's import-time Math.random is the same after the restart.
    const again = await b.s.deployCode(app(3));
    expect((again.version.modules.get("messages.js")!.module.namespace as { seeded: number }).seeded).toBe(seeded);
  });

  test("an embedded server does not load deployed code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-code-"));
    dirs.push(dir);
    const store = new MemoryBlobStore();
    const a = await deployable(dir, store as never);
    await a.s.deployCode(app(4));
    await a.s.shutdown();
    const engine = await new Engine(
      defineSchema({ items: defineTable(v.any()) }),
      new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }),
    ).init();
    const s = createServer({ engine, functions: new Functions(engine), port: 0, moduleStorage: store });
    stops.push(() => s.shutdown());
    await s.codeReady;
    const r = (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "messages:version", args: {} }),
      })
    ).json()) as { errorMessage?: string };
    expect(r.errorMessage).toContain("Could not find public function");
  });
});
