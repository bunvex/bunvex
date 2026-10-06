// `TableDefinition.staged()` against the official package (STUDY-106): the same schema, written with each
// package's own `defineTable` and validators, gives the same table JSON (`stagedDocumentType` included), and a
// second call fails with the same message.
import { describe, expect, test } from "bun:test";
import { defineSchema as bunvexSchema, defineTable as bunvexTable, schemaToJson } from "@bunvex/core";
import { v as bv } from "@bunvex/values";
import { defineSchema, defineTable } from "convex/server";
import { v as cv } from "convex/values";

// biome-ignore lint/suspicious/noExplicitAny: one definition for both packages' builders and validators
type Any = any;

/** The tables, each written once over a package's `defineTable` and `v`. */
const tables = (table: Any, v: Any) => ({
  fields: table({ author: v.string() })
    .index("by_author", ["author"])
    .staged({ author: v.array(v.string()), n: v.optional(v.int64()) }),
  validator: table({ k: v.string() }).staged(
    v.union(v.object({ k: v.literal("a") }), v.object({ k: v.literal("b"), at: v.float64() })),
  ),
  anything: table(v.any()).staged(v.any()),
  none: table({ x: v.number() }),
});

describe(".staged(), as the official package's", () => {
  test("the schema JSON: each table's stagedDocumentType, absent without one", () => {
    const theirs = JSON.parse((defineSchema(tables(defineTable, cv) as Any) as Any).export()) as { tables: Any[] };
    const ours = schemaToJson(bunvexSchema(tables(bunvexTable, bv)));
    const staged = (ts: Any[]) => ts.map((t) => [t.tableName, t.stagedDocumentType]);
    expect(staged(ours.tables)).toEqual(staged(theirs.tables));
    expect(ours.tables.map((t) => "stagedDocumentType" in t)).toEqual(
      theirs.tables.map((t) => "stagedDocumentType" in t),
    );
  });

  test("a second call: the same error", () => {
    const message = (table: Any, v: Any) => {
      try {
        table({ a: v.string() }).staged({ a: v.number() }).staged({ a: v.boolean() });
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    expect(message(bunvexTable, bv)).toBe(message(defineTable, cv));
  });
});
