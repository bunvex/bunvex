// `db.insert` / `db.patch` / `db.replace`'s argument errors in Convex's words and order (STUDY-161 §1, §2): a missing
// argument (its JS side's `validateArg`), the value (nesting, then an object), then the table's name (the syscall's
// `with_argument_error`, the identifier's own message). Each message checked against Convex's backend.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ free: defineTable(v.any()) });
const engine = async () => new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();

/** The error a call throws: its class and message. */
async function thrown(p: () => Promise<unknown>): Promise<[string, string]> {
  try {
    await p();
  } catch (e) {
    return [(e as Error).constructor.name, (e as Error).message];
  }
  throw new Error("did not fail");
}

const nested = (depth: number) => {
  let x: unknown = 1;
  for (let i = 0; i < depth; i++) x = { a: x };
  return x as Record<string, unknown>;
};

test("db.insert's table: the identifier's message under the argument's prefix", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    const insert = (table: string) => thrown(() => db.insert(table, {}));
    const prefix = "Invalid argument `table` for `db.insert`: ";
    expect(await insert("9lives")).toEqual([
      "Error",
      `${prefix}Invalid first character '9' in 9lives: Identifiers must start with an alphabetic character or underscore`,
    ]);
    expect(await insert("")).toEqual(["Error", `${prefix}Identifier cannot be empty`]);
    expect(await insert("a".repeat(65))).toEqual(["Error", `${prefix}Identifier is too long (65 > maximum 64)`]);
    expect(await insert("a​b")).toEqual([
      "Error",
      `${prefix}Identifier a​b has invalid character '\\u{200b}': Identifiers can only contain alphanumeric characters or underscores`,
    ]);
    // a `_` name is refused first, by the JS side
    expect(await insert("__")).toEqual(["Error", "System tables (prefixed with `_`) are read-only."]);
    // `db.table(name)` is the same call
    expect(
      await thrown(() => (db.table("9x") as never as { insert: (v: object) => Promise<string> }).insert({})),
    ).toEqual([
      "Error",
      `${prefix}Invalid first character '9' in 9x: Identifiers must start with an alphabetic character or underscore`,
    ]);
  });
  // nothing was created
  expect(e.catalog.tables.has("9lives")).toBe(false);
});

test("db.count's table: the same check under its own prefix", async () => {
  const e = await engine();
  expect(await thrown(() => e.query((db) => db.query("a-b").count()))).toEqual([
    "Error",
    "Invalid argument `table` for `db.count`: Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
  ]);
});

test("a value that is not an object: Convex's plain error, for each write, before the table", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    const id = await db.insert("free", { k: 1 });
    for (const value of [1, "s", [1], null, true]) {
      expect(await thrown(() => db.insert("free", value as never))).toEqual([
        "Error",
        "Invalid argument `value` for `db.insert`: Value must be an Object",
      ]);
      expect(await thrown(() => db.patch(id, value as never))).toEqual([
        "Error",
        "Invalid argument `value` for `db.patch`: Value must be an Object",
      ]);
      expect(await thrown(() => db.replace(id, value as never))).toEqual([
        "Error",
        "Invalid argument `value` for `db.replace`: Value must be an Object",
      ]);
    }
    // the value is parsed before the table
    expect(await thrown(() => db.insert("9x", 1 as never))).toEqual([
      "Error",
      "Invalid argument `value` for `db.insert`: Value must be an Object",
    ]);
    // a patch is an object first: an array past the size limit is still "not an object" (Convex's `PatchValue`)
    expect((await thrown(() => db.patch(id, new Array(9000).fill(0) as never)))[1]).toBe(
      "Invalid argument `value` for `db.patch`: Value must be an Object",
    );
    // what is not a value at all keeps the serializer's error, which Convex's JS side gives first
    expect((await thrown(() => db.insert("free", Symbol("s") as never)))[1]).not.toContain("Value must be an Object");
  });
});

test("a value nested past the limit: the parse's message under the argument's prefix", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    expect(await thrown(() => db.insert("9x", nested(65)))).toEqual([
      "Error",
      "Invalid argument `value` for `db.insert`: Value is too nested (nested 65 levels deep > maximum nesting 64)",
    ]);
  });
});

test("a missing argument: Convex's `validateArg`, a TypeError", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    const id = await db.insert("free", { k: 1 });
    const call = db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    expect(await thrown(() => call.insert!("free"))).toEqual(["TypeError", "Must provide arg 2 `value` to `insert`"]);
    expect(await thrown(() => call.patch!(id))).toEqual(["TypeError", "Must provide arg 2 `value` to `patch`"]);
    expect(await thrown(() => call.replace!(id))).toEqual(["TypeError", "Must provide arg 2 `value` to `replace`"]);
    expect(await thrown(() => call.patch!())).toEqual(["TypeError", "Must provide arg 1 `id` to `patch`"]);
    expect(await thrown(() => call.replace!())).toEqual(["TypeError", "Must provide arg 1 `id` to `replace`"]);
  });
});

test("a value made in another realm (a pushed module's context) is parsed the same", async () => {
  const { runInNewContext } = await import("node:vm");
  const e = await engine();
  await e.mutation(async (db) => {
    const deep = runInNewContext("let x = 1; for (let i = 0; i < 65; i++) x = { a: x }; x") as Record<string, unknown>;
    expect(await thrown(() => db.insert("free", deep))).toEqual([
      "Error",
      "Invalid argument `value` for `db.insert`: Value is too nested (nested 65 levels deep > maximum nesting 64)",
    ]);
  });
  // and a commit-time placeholder inside one resolves at the commit
  const { value: id, ts } = await e.mutationWithTs((db) =>
    db.insert("free", runInNewContext("({ at: { ts: placeholder } })", { placeholder: db.vars!.commitTs })),
  );
  expect((await e.query((db) => db.get(id)))!.at).toEqual({ ts });
});
