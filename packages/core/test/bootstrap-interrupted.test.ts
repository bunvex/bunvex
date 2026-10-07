// A bootstrap interrupted between its rows at ts 0 and its four globals (STUDY-133 PR 7): with the newest start
// taking the lease (DV-413), a second start can take a new store from a first one right there. The next start
// completes the globals from those rows; a store with any later commit stays refused, as Convex's.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { BOOTSTRAP_GLOBALS, bootstrapStore } from "../src/bootstrap.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const path = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-boot-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const globals = (file: string) => {
  const db = new Database(file);
  try {
    return Object.fromEntries(
      (db.query("select key, json_value from persistence_globals").all() as { key: string; json_value: string }[])
        .filter((r) => (Object.values(BOOTSTRAP_GLOBALS) as string[]).includes(r.key))
        .map((r) => [r.key, r.json_value]),
    );
  } finally {
    db.close();
  }
};
const dropGlobals = (file: string) => {
  const db = new Database(file);
  db.run(
    `delete from persistence_globals where key in (${Object.values(BOOTSTRAP_GLOBALS)
      .map(() => "?")
      .join()})`,
    [...Object.values(BOOTSTRAP_GLOBALS)],
  );
  db.close();
};

test("rows at ts 0 without their globals: the next start completes the same globals and opens", async () => {
  const file = path();
  let p = new SqlitePersistence(file, { durable: false });
  await bootstrapStore(p);
  p.close();
  const want = globals(file);
  expect(Object.keys(want).length).toBe(4);
  dropGlobals(file);
  expect(Object.keys(globals(file)).length).toBe(0);
  p = new SqlitePersistence(file, { durable: false });
  const e = await new Engine(defineSchema({ items: defineTable({ n: v.number() }) }), p).init();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  expect(((await e.query((db) => db.query("items").collect())) as unknown[]).length).toBe(1);
  await e.close();
  expect(globals(file)).toEqual(want);
});

test("a store with a commit after ts 0 and no globals is still refused (Convex's message)", async () => {
  const file = path();
  const e = await new Engine(
    defineSchema({ items: defineTable({ n: v.number() }) }),
    new SqlitePersistence(file, { durable: false }),
  ).init();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  await e.close();
  dropGlobals(file);
  let err: unknown = null;
  try {
    await bootstrapStore(new SqlitePersistence(file, { durable: false }));
  } catch (x) {
    err = x;
  }
  expect(String(err)).toContain("missing _tables.by_id global");
});
