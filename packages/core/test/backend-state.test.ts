// `_backend_state` as Convex writes it (STUDY-134, DV-427): its one document, running, from the store's first
// start (Convex's `initialize_application_system_tables` → `BackendStateModel::initialize`).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKEND_STATE_TABLE } from "../src/catalog.ts";
import { Engine, readSystemRows } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema } from "../src/schema.ts";
import { convexRows, shapeDiff, stored } from "./convex-rows/shape.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open(path: string) {
  const p = await MemoryPersistence.open(path, { durable: false });
  const e = await new Engine(defineSchema({}), p).init();
  return { p, e };
}

test("the first start writes the running state's document, shaped as Convex's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backend-state-"));
  dirs.push(dir);
  const { p, e } = await open(join(dir, "db"));
  const rows = await readSystemRows(p, BACKEND_STATE_TABLE);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ system: "none", usage_limit: "none", user: "none" });
  expect(shapeDiff(stored(rows[0]), convexRows(BACKEND_STATE_TABLE)[0]!)).toEqual([]);
  await e.close();
});

test("a later start keeps the stored document, and a paused state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backend-state-"));
  dirs.push(dir);
  const path = join(dir, "db");
  {
    const { p, e } = await open(path);
    const [row] = await readSystemRows(p, BACKEND_STATE_TABLE);
    await e.mutation((db) => db.asSystem(() => db.patch(BACKEND_STATE_TABLE, row!._id as string, { user: "paused" })));
    await e.close();
    await p.close?.();
  }
  const { p, e } = await open(path);
  const rows = await readSystemRows(p, BACKEND_STATE_TABLE);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ system: "none", usage_limit: "none", user: "paused" });
  await e.close();
});
