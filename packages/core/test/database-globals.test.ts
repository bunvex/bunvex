import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_VERSION } from "../src/database-globals.ts";
import { Engine } from "../src/engine.ts";
import type { Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema } from "../src/schema.ts";

const dirs: string[] = [];
const open: Persistence[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath() {
  const d = mkdtempSync(join(tmpdir(), "bunvex-db-globals-"));
  dirs.push(d);
  return join(d, "log");
}
async function engine(path: string, instanceName = "my-instance") {
  const p = await MemoryPersistence.open(path, { durable: false });
  open.push(p);
  return new Engine(defineSchema({}), p, { instanceName }).init();
}
const restart = async (path: string, instanceName?: string) => {
  await open.pop()!.close();
  return engine(path, instanceName);
};
const rows = (e: Engine, table: string) =>
  e.query((db) => db.asSystem(() => db.query(table).collect())) as Promise<Record<string, unknown>[]>;

describe("`_db`, the database globals, as Convex's (STUDY-126)", () => {
  test("written once at the first start: version, a prefix secret, no storage yet; Convex's number", async () => {
    const path = logPath();
    const e = await engine(path);
    expect(e.catalog.table("_db").number).toBe(520);
    const [g] = await rows(e, "_db");
    expect(g).toMatchObject({ version: DATABASE_VERSION, storageType: null });
    expect(typeof g!.version).toBe("bigint");
    expect(g!.awsPrefixSecret).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const again = await restart(path);
    expect(await rows(again, "_db")).toEqual([g!]);
  });

  test("`_instance` keeps the instance secret and name only", async () => {
    const e = await engine(logPath());
    await e.initializeStorage({ tag: "s3" });
    const [instance] = await rows(e, "_instance");
    expect(Object.keys(instance!).sort()).toEqual(["_creationTime", "_id", "instanceName", "instanceSecret"]);
  });

  test("the first storage is recorded: S3 with an `<instance name>-<uuid>/` prefix, kept across starts", async () => {
    const path = logPath();
    const e = await engine(path);
    const t = await e.initializeStorage({ tag: "s3" });
    expect(t.tag).toBe("s3");
    expect((t as { s3Prefix: string }).s3Prefix).toMatch(/^my-instance-[0-9a-f-]{36}\/$/);
    expect((await rows(e, "_db"))[0]!.storageType).toEqual(t);
    const again = await restart(path);
    expect(await again.initializeStorage({ tag: "s3" })).toEqual(t);
  });

  test("a local directory may move: the new one is recorded", async () => {
    const path = logPath();
    const e = await engine(path);
    expect(await e.initializeStorage({ tag: "local", dir: "a" })).toEqual({ tag: "local", dir: "a" });
    const again = await restart(path);
    expect(await again.initializeStorage({ tag: "local", dir: "b" })).toEqual({ tag: "local", dir: "b" });
    expect((await rows(again, "_db"))[0]!.storageType).toEqual({ tag: "local", dir: "b" });
  });

  test("switching between local and S3 is refused with Convex's message", async () => {
    const path = logPath();
    const e = await engine(path);
    await e.initializeStorage({ tag: "local", dir: "store" });
    await expect(e.initializeStorage({ tag: "s3" })).rejects.toThrow(
      'Database was initialized with Some(Local { dir: "store" }), but backend started up with S3.',
    );
    const other = await engine(logPath());
    const t = (await other.initializeStorage({ tag: "s3" })) as { s3Prefix: string };
    await expect(other.initializeStorage({ tag: "local", dir: "x" })).rejects.toThrow(
      `Database was initialized with Some(S3 { s3_prefix: "${t.s3Prefix}" }), but backend started up with Local { dir: "x" }.`,
    );
  });

  test("an S3 prefix belongs to its instance: another name is refused", async () => {
    const path = logPath();
    const e = await engine(path);
    const t = (await e.initializeStorage({ tag: "s3" })) as { s3Prefix: string };
    const renamed = await restart(path, "other");
    await expect(renamed.initializeStorage({ tag: "s3" })).rejects.toThrow(
      `Cannot use s3 storage path ${t.s3Prefix} with other`,
    );
  });
});
