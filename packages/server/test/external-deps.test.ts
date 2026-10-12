// The deployment's side of external packages (STUDY-148), below the end-to-end tests in packages/cli: the cache of
// Convex's `get_cached_package_match` (the 10 newest rows, packages compared as a map), the extraction of a stored
// archive (its sha256 checked, only `node_modules/` entries, modes and symlinks kept), and the push's
// `nodeDependencies`.
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine, EXTERNAL_DEPS_PACKAGES_TABLE } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { CACHE_ENTRIES, cachedExternalDeps, type ExternalDepsPackage, externalDepsPath } from "../src/external-deps.ts";
import { PushError, parseNodeDependencies } from "../src/push.ts";
import { ZipFileWriter } from "../src/zip-writer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function engine() {
  return new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: "external-deps-test",
    instanceSecret: "12".repeat(32),
  }).init();
}

const row = (deps: [string, string][]) => ({
  storageKey: crypto.randomUUID(),
  sha256: new ArrayBuffer(32),
  deps: deps.map(([p, version]) => ({ package: p, version })),
  packageSize: { zippedSizeBytes: 1n, unzippedSizeBytes: 1n },
});

describe("the cache of installs (Convex's get_cached_package_match)", () => {
  test("the newest row with the same packages and versions, in any order; only the 10 newest are looked at", async () => {
    const e = await engine();
    const insert = (r: ReturnType<typeof row>) =>
      e.mutation((db) => db.asSystem(() => db.insert(EXTERNAL_DEPS_PACKAGES_TABLE, r as never))) as Promise<string>;
    const old = await insert(row([["a", "1.0.0"]]));
    expect((await cachedExternalDeps(e, [{ name: "a", version: "1.0.0" }]))?._id).toBe(old);
    const pair = await insert(
      row([
        ["a", "1.0.0"],
        ["b", "2.0.0"],
      ]),
    );
    const newer = await insert(
      row([
        ["b", "2.0.0"],
        ["a", "1.0.0"],
      ]),
    );
    expect(
      (
        await cachedExternalDeps(e, [
          { name: "a", version: "1.0.0" },
          { name: "b", version: "2.0.0" },
        ])
      )?._id,
    ).toBe(newer);
    expect(pair).not.toBe(newer);
    // Another version, or a subset, is no match.
    expect(await cachedExternalDeps(e, [{ name: "a", version: "1.0.1" }])).toBeNull();
    expect(await cachedExternalDeps(e, [{ name: "b", version: "2.0.0" }])).toBeNull();
    // Once 10 newer rows exist, the first one is out of reach.
    for (let i = 0; i < CACHE_ENTRIES - 2; i++) await insert(row([["filler", `${i}.0.0`]]));
    expect((await cachedExternalDeps(e, [{ name: "a", version: "1.0.0" }]))?._id).toBeUndefined();
  });
});

/** A stored archive of `entries` (name, bytes or a link target, Unix mode) and its row. */
async function stored(entries: { name: string; data: string; mode?: number }[], tamper = false) {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-ext-zip-"));
  dirs.push(dir);
  const path = join(dir, "deps.zip");
  const zip = new ZipFileWriter(path);
  for (const e of entries) await zip.add(e.name, e.data, e.mode);
  await zip.finish();
  const store = new MemoryBlobStore();
  const w = await store.put(Bun.file(path));
  const sha256 = w.sha256.slice().buffer;
  if (tamper) new Uint8Array(sha256)[0]! ^= 1;
  const r: ExternalDepsPackage = {
    _id: "x",
    storageKey: w.key,
    sha256,
    deps: [],
    packageSize: { zippedSizeBytes: BigInt(w.size), unzippedSizeBytes: 0n },
  };
  return { store, row: r };
}

describe("extracting an install (Convex's downloadExternalPackage)", () => {
  test("files, directories, Unix modes and symlinks come back; the directory is the process's", async () => {
    const { store, row: r } = await stored([
      { name: "node_modules/p/", data: "", mode: 0o040755 },
      { name: "node_modules/p/index.js", data: "exports.x = 1;", mode: 0o100644 },
      { name: "node_modules/p/bin/run.sh", data: "#!/bin/sh\necho ran\n", mode: 0o100755 },
      { name: "node_modules/.bin/run", data: "../p/bin/run.sh", mode: 0o120755 },
      // No mode recorded: written as plain files.
      { name: "node_modules/p/data.txt", data: "hi" },
    ]);
    const dir = await externalDepsPath(store, r);
    expect(dir).toMatch(new RegExp(`/bunvex-node-[^/]+/${r.storageKey}$`));
    expect(readFileSync(join(dir, "node_modules/p/index.js"), "utf8")).toBe("exports.x = 1;");
    expect(lstatSync(join(dir, "node_modules/p/bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(dir, "node_modules/p/index.js")).mode & 0o777).toBe(0o644);
    expect(readlinkSync(join(dir, "node_modules/.bin/run"))).toBe("../p/bin/run.sh");
    expect(Bun.spawnSync([join(dir, "node_modules/.bin/run")]).stdout.toString()).toBe("ran\n");
    expect(readFileSync(join(dir, "node_modules/p/data.txt"), "utf8")).toBe("hi");
    // Extracted once per process.
    expect(await externalDepsPath(store, r)).toBe(dir);
  });

  test("a damaged archive, or an entry outside node_modules/, is refused", async () => {
    const tampered = await stored([{ name: "node_modules/p/index.js", data: "x" }], true);
    expect(await externalDepsPath(tampered.store, tampered.row).catch((e) => e.message)).toBe(
      `the external packages ${tampered.row.storageKey} do not match their sha256`,
    );
    const outside = await stored([{ name: "modules/x.js", data: "x" }]);
    expect(await externalDepsPath(outside.store, outside.row).catch((e) => e.message)).toBe(
      "found incorrect package entry modules/x.js",
    );
    const climbing = await stored([{ name: "node_modules/../../escape.js", data: "x" }]);
    expect(await externalDepsPath(climbing.store, climbing.row).catch((e) => e.message)).toBe(
      "found incorrect package entry node_modules/../../escape.js",
    );
    // A failure is not remembered: the next call tries again (and fails again here).
    expect(await externalDepsPath(outside.store, outside.row).catch((e) => e.message)).toBe(
      "found incorrect package entry modules/x.js",
    );
  });
});

test("a push's nodeDependencies: {name, version} strings, else the body's 400", () => {
  expect(parseNodeDependencies(undefined)).toEqual([]);
  expect(parseNodeDependencies([])).toEqual([]);
  expect(parseNodeDependencies([{ name: "a", version: "1.0.0", extra: 1 }])).toEqual([{ name: "a", version: "1.0.0" }]);
  for (const bad of [5, null, {}, [{ name: "a" }], [{ name: 1, version: "1" }], ["a@1"]]) {
    let error: unknown;
    try {
      parseNodeDependencies(bad);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PushError);
    expect((error as PushError).code).toBe("BadJsonBody");
  }
});
