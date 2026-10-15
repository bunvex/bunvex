// A schema error's document and validator without the system fields (STUDY-161 §3), as Convex's
// `DocumentSchema::check_value` (every top-level `_` field left out of the document; the schema's validator, which
// never names them). The write's messages checked against Convex's backend.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const PREFIX = 'Failed to insert or update a document in table "strict" because it does not match the schema: ';
const schema = defineSchema({
  strict: defineTable({ name: v.string(), n: v.optional(v.number()) }),
  either: defineTable(v.union(v.object({ kind: v.literal("a") }), v.object({ kind: v.literal("b"), x: v.number() }))),
});
const engine = async () => new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not fail");
}

const VALIDATOR = "Validator: v.object({n: v.optional(v.float64()), name: v.string()})";
const MISSING =
  "Object is missing the required field `name`. Consider wrapping the field validator in `v.optional(...)` if this is expected.";

test("a missing field: the document and validator without `_id` and `_creationTime`", async () => {
  const e = await engine();
  expect(await message(e.mutation((db) => db.insert("strict", {})))).toBe(
    `${PREFIX}${MISSING}\n\nObject: {}\n${VALIDATOR}`,
  );
  expect(await message(e.mutation((db) => db.insert("strict", { n: 1 })))).toBe(
    `${PREFIX}${MISSING}\n\nObject: {n: 1.0}\n${VALIDATOR}`,
  );
});

test("an extra field, and a patch or replace that leaves a required one out", async () => {
  const e = await engine();
  expect(await message(e.mutation((db) => db.insert("strict", { name: "a", extra: 1 })))).toBe(
    `${PREFIX}Object contains extra field \`extra\` that is not in the validator.\n\nObject: {extra: 1.0, name: "a"}\n${VALIDATOR}`,
  );
  const id = await e.mutation((db) => db.insert("strict", { name: "a" }));
  expect(await message(e.mutation((db) => db.patch(id, { name: undefined, n: 2 })))).toBe(
    `${PREFIX}${MISSING}\n\nObject: {n: 2.0}\n${VALIDATOR}`,
  );
  expect(await message(e.mutation((db) => db.replace(id, { n: 3 })))).toBe(
    `${PREFIX}${MISSING}\n\nObject: {n: 3.0}\n${VALIDATOR}`,
  );
  // a wrong value's error was already Convex's: its path and value
  expect(await message(e.mutation((db) => db.insert("strict", { name: 1 } as never)))).toBe(
    `${PREFIX}Value does not match validator.\nPath: .name\nValue: 1.0\nValidator: v.string()`,
  );
});

test("a union of objects: every member as declared, the document without its system fields", async () => {
  const e = await engine();
  const text = await message(e.mutation((db) => db.insert("either", { kind: "b" })));
  expect(text).not.toContain("_id");
  expect(text).not.toContain("_creationTime");
  expect(await e.mutation((db) => db.insert("either", { kind: "a" }))).toBeString();
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a push's walk of the existing documents shows them the same way", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-schema-display-"));
  dirs.push(dir);
  const e = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true })).init();
  try {
    const p0 = await e.startSchemaPush(defineSchema({ strict: defineTable(v.any()) }));
    for (let i = 0; i < 100 && (await e.schemaPushStatus(p0.schemaId)).type !== "complete"; i++) await Bun.sleep(10);
    await e.commitSchemaPush(p0.schemaId, async () => {});
    const bad = await e.mutation((db) => db.insert("strict", { n: 1 }));
    const p = await e.startSchemaPush(
      defineSchema({ strict: defineTable({ name: v.string(), n: v.optional(v.number()) }) }),
    );
    for (let i = 0; i < 300 && (await e.schemaPushStatus(p.schemaId)).type !== "failed"; i++) await Bun.sleep(10);
    expect(await e.schemaPushStatus(p.schemaId)).toEqual({
      type: "failed",
      tableName: "strict",
      error: `Document with ID "${bad}" in table "strict" does not match the schema: ${MISSING}\n\nObject: {n: 1.0}\n${VALIDATOR}`,
    });
  } finally {
    await e.close();
  }
});
