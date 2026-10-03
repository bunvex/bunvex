// `db.table(name)`, as Convex's table-scoped API (STUDY-66 §2): each method is the two-argument form with
// the table filled in; a query's `db.table` (and a query run inside a mutation) is a reader; `db.system.table`
// reads a system table.
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, type GenericDataModel } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import type { MutationBuilderWithTable, QueryBuilderWithTable } from "../src/registration.ts";

// The table-scoped API's builders, as an app's `_generated/server` would bind them.
const queryT = query as unknown as QueryBuilderWithTable<GenericDataModel, "public">;
const mutationT = mutation as unknown as MutationBuilderWithTable<GenericDataModel, "public">;
type Raw = { table(name: string): Record<string, (...a: unknown[]) => unknown> };

async function setup() {
  const engine = await new Engine(
    defineSchema({
      users: defineTable({ name: v.string(), age: v.optional(v.number()) }),
      posts: defineTable(v.any()),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    add: mutationT(async (ctx, { name }: { name: string }) => ctx.db.table("users").insert({ name })),
    get: queryT((ctx, { id }: { id: string }) => ctx.db.table("users").get(id as never)),
    list: queryT((ctx) => ctx.db.table("users").query().withIndex("by_creation_time").collect()),
    edit: mutationT(async (ctx, { id }: { id: string }) => {
      const users = ctx.db.table("users");
      await users.patch(id as never, { age: 3 });
      const patched = await users.get(id as never);
      await users.replace(id as never, { name: "grace" });
      const replaced = await users.get(id as never);
      await users.delete(id as never);
      return { patched, replaced, gone: await users.get(id as never) };
    }),
    // What the scoped writer refuses, each as its two-argument form or Convex's argument check.
    refuse: mutationT(async (ctx, { id, postId }: { id: string; postId: string }) => {
      const users = ctx.db.table("users") as unknown as Raw["table"] extends (n: string) => infer T ? T : never;
      const out: string[] = [];
      const attempt = async (f: () => unknown) => {
        try {
          await f();
          out.push("ok");
        } catch (e) {
          out.push((e as Error).message);
        }
      };
      await attempt(() => users.patch!(id));
      await attempt(() => users.patch!(undefined, {}));
      await attempt(() => users.replace!(id));
      await attempt(() => users.delete!());
      await attempt(() => users.get!());
      await attempt(() => users.insert!());
      await attempt(() => users.insert!({ name: 1 }));
      await attempt(() => users.get!(postId));
      await attempt(() => users.patch!(postId, { a: 1 }));
      return out;
    }),
    readerInQuery: query((ctx) => writeMethods(ctx.db)),
    readerInNestedQuery: mutation((ctx) => ctx.runQuery("m:readerInQuery", {})),
    writerInMutation: mutation((ctx) => writeMethods(ctx.db)),
    files: query((ctx) => ((ctx.db.system as unknown as Raw).table("_storage").query!() ? "a query" : "no query")),
  });
  return { engine, fns };
}

/** Which write methods `db.table("users")` has. */
function writeMethods(db: unknown): string[] {
  const t = (db as Raw).table("users");
  return ["insert", "patch", "replace", "delete"].filter((m) => typeof t[m] === "function");
}

describe("db.table(name)", () => {
  test("insert, get, query, patch, replace, delete, through the scoped table", async () => {
    const { fns } = await setup();
    const id = (await fns.runMutation("m:add", { name: "ada" })) as string;
    expect(await fns.runQuery("m:get", { id })).toMatchObject({ _id: id, name: "ada" });
    expect(((await fns.runQuery("m:list", {})) as { name: string }[]).map((d) => d.name)).toEqual(["ada"]);
    const r = (await fns.runMutation("m:edit", { id })) as Record<string, unknown>;
    expect(r.patched).toMatchObject({ name: "ada", age: 3 });
    expect(r.replaced).toMatchObject({ name: "grace" });
    expect((r.replaced as Record<string, unknown>).age).toBeUndefined();
    expect(r.gone).toBeNull();
  });

  test("a missing argument is Convex's TypeError; the rest are the two-argument forms' errors", async () => {
    const { fns, engine } = await setup();
    const id = (await fns.runMutation("m:add", { name: "ada" })) as string;
    const postId = await engine.mutation((db) => db.insert("posts", {}));
    const out = (await fns.runMutation("m:refuse", { id, postId })) as string[];
    expect(out.slice(0, 6)).toEqual([
      "Must provide arg 2 `value` to `patch`",
      "Must provide arg 1 `id` to `patch`",
      "Must provide arg 2 `value` to `replace`",
      "Must provide arg 1 `id` to `delete`",
      "Must provide arg 1 `id` to `get`",
      "Must provide arg 2 `value` to `insert`",
    ]);
    // Schema validation, and an id of another table, as `db.insert("users", …)` / `db.get("users", id)`.
    const two = await engine
      .mutation(async (db) => {
        const r: string[] = [];
        for (const f of [
          () => db.insert("users", { name: 1 }),
          () => db.get("users", postId),
          () => db.patch("users", postId, { a: 1 }),
        ])
          await Promise.resolve(f()).then(
            () => r.push("ok"),
            (e: Error) => r.push(e.message),
          );
        return r;
      })
      .catch((e: Error) => [e.message]);
    expect(out.slice(6)).toEqual(two);
  });

  test("a reader in a query and in a query run by a mutation, a writer in a mutation", async () => {
    const { fns } = await setup();
    expect(await fns.runQuery("m:readerInQuery", {})).toEqual([]);
    expect(await fns.runMutation("m:readerInNestedQuery", {})).toEqual([]);
    expect(await fns.runMutation("m:writerInMutation", {})).toEqual(["insert", "patch", "replace", "delete"]);
  });

  test("db.system.table(name) reads a system table", async () => {
    const { fns } = await setup();
    expect(await fns.runQuery("m:files", {})).toBe("a query");
  });
});
