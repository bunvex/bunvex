// Convex's `Validator::is_subset` and `from_shape` (STUDY-106 §7.4): which pushes need no walk of the documents.
import { afterEach, describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { NEVER, tableShape } from "../src/shapes.ts";
import {
  documentValidator,
  isSubset,
  tableValidationOutcome,
  validatorFromShape,
  withoutSystemFields,
} from "../src/validator-subset.ts";

// biome-ignore lint/suspicious/noExplicitAny: validator JSON in tests
const j = (x: { json: unknown }) => x.json as any;
const sub = (a: { json: unknown }, b: { json: unknown }) => isSubset(j(a), j(b));
const obj = (fields: Parameters<typeof v.object>[0]) => v.object(fields);
const noTables = () => undefined;

describe("isSubset, Convex's arms", () => {
  test("widening is a subset, narrowing is not", () => {
    expect(sub(v.number(), v.union(v.number(), v.string()))).toBe(true);
    expect(sub(v.union(v.number(), v.string()), v.number())).toBe(false);
    expect(sub(v.union(v.string(), v.number()), v.union(v.number(), v.string()))).toBe(true);
    expect(sub(v.array(v.number()), v.array(v.union(v.number(), v.null())))).toBe(true);
    expect(sub(v.array(v.string()), v.array(v.number()))).toBe(false);
  });

  test("objects: a new optional field is fine; a new required one, a removed one or optional→required are not", () => {
    expect(sub(obj({ a: v.number() }), obj({ a: v.number(), b: v.optional(v.string()) }))).toBe(true);
    expect(sub(obj({ a: v.number() }), obj({ a: v.number(), b: v.string() }))).toBe(false);
    expect(sub(obj({ a: v.number(), b: v.string() }), obj({ a: v.number() }))).toBe(false);
    expect(sub(obj({ a: v.optional(v.number()) }), obj({ a: v.number() }))).toBe(false);
    expect(sub(obj({ a: v.number() }), obj({ a: v.optional(v.number()) }))).toBe(true);
    expect(sub(obj({ a: obj({ x: v.string() }) }), obj({ a: obj({ x: v.union(v.string(), v.null()) }) }))).toBe(true);
  });

  test("literals, ids, booleans, any", () => {
    expect(sub(v.literal("a"), v.string())).toBe(true);
    expect(sub(v.literal(1), v.number())).toBe(true);
    expect(sub(v.literal(1n), v.int64())).toBe(true);
    expect(sub(v.literal(1n), v.number())).toBe(false);
    expect(sub(v.literal(true), v.boolean())).toBe(true);
    expect(sub(v.literal("a"), v.number())).toBe(false);
    expect(sub(v.id("users"), v.string())).toBe(true);
    expect(sub(v.string(), v.id("users"))).toBe(false);
    expect(sub(v.id("users"), v.id("teams"))).toBe(false);
    expect(sub(v.boolean(), v.union(v.literal(true), v.literal(false)))).toBe(true);
    expect(sub(v.boolean(), v.union(v.literal(true), v.string()))).toBe(false);
    expect(sub(v.string(), v.any())).toBe(true);
    expect(sub(v.any(), v.string())).toBe(false);
    expect(sub(v.record(v.string(), v.number()), v.record(v.string(), v.number()))).toBe(true);
  });

  test("a document validator is a union of its objects; none is any", () => {
    expect(documentValidator(undefined)).toEqual({ type: "any" });
    expect(documentValidator(j(obj({ a: v.number() })))).toEqual({ type: "union", value: [j(obj({ a: v.number() }))] });
  });
});

describe("validatorFromShape", () => {
  test("a table's shape as a validator, system fields left out at the top", () => {
    const shape = tableShape([
      { _id: "x", _creationTime: 1, n: 1, s: "a", b: true, big: 2n, l: [1, 2] },
      { _id: "y", _creationTime: 2, n: 2.5, s: "b", b: false, big: 3n, l: [] },
    ]);
    const val = withoutSystemFields(validatorFromShape(shape, noTables));
    const next = documentValidator(
      j(obj({ n: v.number(), s: v.string(), b: v.boolean(), big: v.int64(), l: v.array(v.number()) })),
    );
    expect(isSubset(val, next)).toBe(true);
    expect(isSubset(val, documentValidator(j(obj({ n: v.string() }))))).toBe(false);
    // Nothing in the table: any validator holds.
    expect(isSubset(validatorFromShape(NEVER, noTables), documentValidator(j(obj({ x: v.string() }))))).toBe(true);
  });
});

describe("tableValidationOutcome, in Convex's order", () => {
  const num = j(obj({ n: v.number() }));
  const wide = j(obj({ n: v.union(v.number(), v.string()) }));
  const lit = j(obj({ n: v.literal(1) }));
  const shape = tableShape([{ _id: "x", _creationTime: 1, n: 1 }]);
  test("each outcome", () => {
    expect(tableValidationOutcome(false, lit, num, shape, noTables)).toBe("notValidated");
    expect(tableValidationOutcome(true, wide, num, shape, noTables)).toBe("supersetOfEnforced");
    expect(tableValidationOutcome(true, num, undefined, shape, noTables)).toBe("supersetOfShape");
    expect(tableValidationOutcome(true, lit, num, shape, noTables)).toBe("mustWalk");
    // No shape (summaries building): walked.
    expect(tableValidationOutcome(true, num, undefined, undefined, noTables)).toBe("mustWalk");
    expect(tableValidationOutcome(true, lit, undefined, NEVER, noTables)).toBe("supersetOfShape");
  });
});

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
});

test("a push predicts and walks only the tables whose validator it cannot prove", async () => {
  const e = await new Engine(defineSchema({}), new SqlitePersistence(":memory:", { durable: false }), {
    storedSchema: true,
    indexBackfill: { chunkRate: null },
  }).init();
  engines.push(e);
  const push = async (s: ReturnType<typeof defineSchema>) => {
    const p = await e.startSchemaPush(s);
    for (let i = 0; i < 2000 && (await e.schemaPushStatus(p.schemaId)).type === "inProgress"; i++) await Bun.sleep(5);
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("complete");
    await e.commitSchemaPush(p.schemaId, async () => {});
  };
  await push(defineSchema({ a: defineTable({ n: v.number() }), b: defineTable(v.any()), c: defineTable(v.any()) }));
  await e.mutation(async (db) => {
    for (let i = 0; i < 5; i++) {
      await db.insert("a", { n: i });
      await db.insert("b", { n: i });
      await db.insert("c", { n: i });
    }
  });
  await e.summariesReady();
  const next = defineSchema({
    a: defineTable({ n: v.union(v.number(), v.string()) }),
    b: defineTable({ n: v.number() }),
    c: defineTable({ n: v.union(v.literal(0), v.literal(1)) }),
  });
  const p = await e.evaluateSchema(next);
  expect(p.tables.map((t) => [t.name, t.outcome])).toEqual([
    ["a", "supersetOfEnforced"],
    ["b", "supersetOfShape"],
    ["c", "mustWalk"],
  ]);
  const started = await e.startSchemaPush(next);
  for (let i = 0; i < 2000; i++) {
    const s = await e.schemaPushStatus(started.schemaId);
    if (s.type !== "inProgress") break;
    await Bun.sleep(5);
  }
  // Only `c` was walked, and its documents 2…4 fail it.
  expect(await e.schemaPushStatus(started.schemaId)).toMatchObject({ type: "failed", tableName: "c" });
});
