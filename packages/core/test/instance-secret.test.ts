import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import type { Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const dirs: string[] = [];
const open: Persistence[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath() {
  const d = mkdtempSync(join(tmpdir(), "bunvex-secret-"));
  dirs.push(d);
  return join(d, "log");
}
async function engine(path: string, instanceSecret?: string) {
  const p = await MemoryPersistence.open(path, { durable: false });
  open.push(p);
  return new Engine(schema, p, { instanceSecret }).init();
}
const firstPage = (e: Engine) => e.query((db) => db.query("items").paginate({ numItems: 2, cursor: null }));
const next = (e: Engine, cursor: string) => e.query((db) => db.query("items").paginate({ numItems: 2, cursor }));

describe("the instance secret, as Convex's self-hosted image (STUDY-17 D2 → option D)", () => {
  test("without INSTANCE_SECRET a random secret is generated once and kept with the data", async () => {
    const path = logPath();
    const a = await engine(path);
    for (let i = 0; i < 5; i++) await a.mutation((db) => db.insert("items", { i }));
    const cursor = (await firstPage(a)).continueCursor;
    await open.pop()!.close();
    const b = await engine(path); // a restart: the stored secret is read back
    expect((await next(b, cursor)).page.map((d) => d.i)).toEqual([2, 3]);
  });

  test("each deployment has its own secret: another store refuses the cursor", async () => {
    const a = await engine(logPath());
    const b = await engine(logPath());
    await a.mutation((db) => db.insert("items", {}));
    const cursor = (await firstPage(a)).continueCursor;
    await expect(next(b, cursor)).rejects.toThrow("InvalidCursor: Failed to parse cursor");
  });

  test("a configured INSTANCE_SECRET wins over the stored one", async () => {
    const path = logPath();
    const stored = await engine(path);
    const storedCursor = (await firstPage(stored)).continueCursor;
    await open.pop()!.close();
    const configured = await engine(path, "configured-secret");
    await expect(next(configured, storedCursor)).rejects.toThrow("Failed to parse cursor");
    const own = (await firstPage(configured)).continueCursor;
    expect((await next(configured, own)).isDone).toBe(true);
  });

  test("app code cannot read _instance", async () => {
    const e = await engine(logPath());
    await expect(e.query((db) => db.query("_instance").collect())).rejects.toThrow(
      "System table _instance is not accessible",
    );
  });
});
