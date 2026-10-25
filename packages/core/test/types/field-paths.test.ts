// Field paths through unions and id-keyed records (STUDY-189 T3), as Convex's: checked by `tsc`
// (`bun run typecheck`); each `Equal` must hold and each `@ts-expect-error` must be an error. The test below only
// keeps bun:test from finding none.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { DataModelFromSchemaDefinition } from "../../src/data-model.ts";
import type { GenericDatabaseReader } from "../../src/database-types.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};
/** The same set of strings, a template that covers another member counting as the same (`r.${string}.x`). */
type SameStrings<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const schema = defineSchema({
  t: defineTable({
    // An object in a union with a non-object: its fields are paths.
    p: v.union(v.object({ s: v.string() }), v.number()),
    // A record keyed by ids: any key is a path, as a string-keyed record's.
    r: v.record(v.id("t"), v.object({ x: v.number() })),
    q: v.record(v.string(), v.number()),
    o: v.optional(v.union(v.object({ a: v.string() }), v.object({ b: v.number() }))),
    arr: v.array(v.object({ x: v.number() })),
  }),
});
type DM = DataModelFromSchemaDefinition<typeof schema>;

check<
  SameStrings<
    DM["t"]["fieldPaths"],
    "_id" | "_creationTime" | "p" | "p.s" | "r" | `r.${string}` | "q" | `q.${string}` | "o" | "o.a" | "o.b" | "arr"
  >
>(true);
// The id key's brand does not leak into the path: a plain string key is one.
check<Equal<"r.abc" extends DM["t"]["fieldPaths"] ? true : false, true>>(true);

function typed(db: GenericDatabaseReader<DM>) {
  db.query("t").filter((q) => q.eq(q.field("p.s"), "x"));
  db.query("t").filter((q) => q.eq(q.field("r.abc"), null));
  db.query("t").filter((q) => q.eq(q.field("r.abc.x"), 1));
  db.query("t").filter((q) => q.eq(q.field("o.b"), 1));
  // @ts-expect-error not into arrays, as Convex's
  db.query("t").filter((q) => q.eq(q.field("arr.x"), 1));
  // @ts-expect-error not a field of the union's object
  db.query("t").filter((q) => q.eq(q.field("p.nope"), 1));
}
void typed;

test("field paths are checked by tsc", () => {
  expect(true).toBe(true);
});
