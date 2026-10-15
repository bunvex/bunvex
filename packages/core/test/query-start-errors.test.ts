// A query's source when it starts, as Convex's backend checks it (STUDY-161 §5): the names parse (a full scan's
// table as an identifier, an index's `table.index` as an index name) under ``Invalid argument `query` for
// `queryStream` `` (`queryPage` for `paginate`), then the index is looked up: `Index <table>.<index> not found.` for
// an index of a table that does not exist (even `by_id` and `by_creation_time`) or that the table lacks. A full scan
// of a missing table is still empty. Messages checked against Convex's local backend (d8bdde0).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const schema = defineSchema({
  free: defineTable(v.any()).index("by_k", ["k"]).searchIndex("s", { searchField: "body" }),
});

async function engine() {
  const p = await MemoryPersistence.open(null, { durable: false });
  return new Engine(schema, p).init();
}

/** The query's error message, or its result. */
async function outcome(e: Engine, run: (db: Tx) => Promise<unknown>): Promise<unknown> {
  return e.query(async (db) => {
    try {
      return { value: await run(db) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
}

const notFound = (name: string) => ({ error: `Index ${name} not found.` });
const stream = (why: string) => ({ error: `Invalid argument \`query\` for \`queryStream\`: ${why}` });
const page = (why: string) => ({ error: `Invalid argument \`query\` for \`queryPage\`: ${why}` });
const badName = (part: string) =>
  `Invalid table name: "${part}". Identifiers must start with a letter and can only contain letters, digits, and underscores.`;
const first = { numItems: 2, cursor: null };

describe("a query's table and index when it starts (STUDY-161 §5)", () => {
  test("an index of a table that does not exist is not found, any index; a full scan finds nothing", async () => {
    const e = await engine();
    const q = (db: Tx) => db.query("nope");
    expect(await outcome(e, (db) => q(db).withIndex("by_creation_time").collect())).toEqual(
      notFound("nope.by_creation_time"),
    );
    expect(await outcome(e, (db) => q(db).withIndex("by_id").first())).toEqual(notFound("nope.by_id"));
    expect(
      await outcome(e, (db) =>
        q(db)
          .withIndex("by_k", (r) => r.eq("k", 1))
          .collect(),
      ),
    ).toEqual(notFound("nope.by_k"));
    expect(await outcome(e, (db) => q(db).withIndex("by_creation_time").paginate(first))).toEqual(
      notFound("nope.by_creation_time"),
    );
    expect(
      await outcome(e, (db) =>
        q(db)
          .withSearchIndex("s", (s) => s.search("body", "x"))
          .collect(),
      ),
    ).toEqual(notFound("nope.s"));
    expect(
      await outcome(e, async (db) => {
        for await (const _ of q(db).withIndex("by_creation_time")) return "a row";
        return "none";
      }),
    ).toEqual(notFound("nope.by_creation_time"));
    expect(await outcome(e, (db) => q(db).collect())).toEqual({ value: [] });
    expect(await outcome(e, (db) => q(db).order("desc").first())).toEqual({ value: null });
  });

  test("an index the table lacks is not found when the query starts, not at `withIndex`", async () => {
    const e = await engine();
    expect(await outcome(e, (db) => db.query("free").withIndex("nope").collect())).toEqual(notFound("free.nope"));
    expect(await outcome(e, (db) => db.query("free").withIndex("_x").paginate(first))).toEqual(notFound("free._x"));
    expect(
      await outcome(e, (db) =>
        db
          .query("free")
          .withSearchIndex("t", (s) => s.search("body", "x"))
          .collect(),
      ),
    ).toEqual(notFound("free.t"));
    // Built without starting: no error.
    expect(
      await outcome(e, async (db) => {
        db.query("free").withIndex("nope");
        return "built";
      }),
    ).toEqual({ value: "built" });
    // The indexes that exist answer.
    expect(await outcome(e, (db) => db.query("free").withIndex("by_k").collect())).toEqual({ value: [] });
    expect(await outcome(e, (db) => db.query("free").withIndex("by_id").collect())).toEqual({ value: [] });
  });

  test("names that do not parse, in Convex's words, under the syscall's name", async () => {
    const e = await engine();
    expect(await outcome(e, (db) => db.query("9x").collect())).toEqual(
      stream("Invalid first character '9' in 9x: Identifiers must start with an alphabetic character or underscore"),
    );
    expect(await outcome(e, (db) => db.query("").collect())).toEqual(stream("Identifier cannot be empty"));
    expect(await outcome(e, (db) => db.query("a-b").first())).toEqual(
      stream(
        "Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
      ),
    );
    expect(await outcome(e, (db) => db.query("a​b").first())).toEqual(
      stream(
        "Identifier a​b has invalid character '\\u{200b}': Identifiers can only contain alphanumeric characters or underscores",
      ),
    );
    expect(await outcome(e, (db) => db.query("9x").withIndex("by_creation_time").collect())).toEqual(
      stream(badName("9x")),
    );
    expect(await outcome(e, (db) => db.query("9x").withIndex("by_creation_time").paginate(first))).toEqual(
      page(badName("9x")),
    );
    expect(await outcome(e, (db) => db.query("free").withIndex("9").collect())).toEqual(stream(badName("9")));
    expect(await outcome(e, (db) => db.query("free").withIndex("").collect())).toEqual(stream(badName("")));
    expect(await outcome(e, (db) => db.query("nope").withIndex("9").collect())).toEqual(stream(badName("9")));
    expect(await outcome(e, (db) => db.query("free").withIndex("a.b").collect())).toEqual(
      stream("Too many components in index name free.a.b"),
    );
    expect(
      await outcome(e, (db) =>
        db
          .query("free")
          .withSearchIndex("9", (s) => s.search("body", "x"))
          .collect(),
      ),
    ).toEqual(stream(badName("9")));
  });

  test("the operators are checked before the names, as Convex parses them", async () => {
    const e = await engine();
    expect(await outcome(e, (db) => db.query("9x").limit(-1).collect())).toEqual(
      stream("invalid value: integer `-1`, expected usize"),
    );
  });

  test("a missing table's index error depends on `_tables`: it runs again once the table is created", async () => {
    const e = await engine();
    const q = async (db: Tx) => {
      try {
        return await db.query("later").withIndex("by_creation_time").collect();
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(await e.query(q, "k")).toBe("Index later.by_creation_time not found.");
    await e.mutation((db) => db.insert("later", { a: 1 }));
    expect(await e.query(q, "k")).toHaveLength(1);
  });
});
