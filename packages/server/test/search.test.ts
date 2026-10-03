// Full-text search from a function (STUDY-45 PR 2): `ctx.db.query(t).withSearchIndex(…)` in a query.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";

test("a query searches with ctx.db; a mutation sees its own writes", async () => {
  const engine = await new Engine(
    defineSchema({
      posts: defineTable({ title: v.string(), tag: v.string() }).searchIndex("search_title", {
        searchField: "title",
        filterFields: ["tag"],
      }),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await engine.searchReady();
  const fns = new Functions(engine).register("posts", {
    add: mutation(async ({ db }, { title, tag }: { title: string; tag: string }) => {
      await db.insert("posts", { title, tag });
      return (
        await db
          .query("posts")
          .withSearchIndex("search_title", (q) => q.search("title", title))
          .collect()
      ).length;
    }),
    find: query(async ({ db }, { text, tag }: { text: string; tag?: string }) =>
      (
        await db
          .query("posts")
          .withSearchIndex("search_title", (q) =>
            tag === undefined ? q.search("title", text) : q.search("title", text).eq("tag", tag),
          )
          .collect()
      ).map((p) => p.title),
    ),
  });
  expect(await fns.runMutation("posts:add", { title: "Hello world", tag: "a" })).toBe(1);
  await fns.runMutation("posts:add", { title: "Hello there", tag: "b" });
  expect((await fns.runQuery("posts:find", { text: "hello" })) as string[]).toHaveLength(2);
  expect(await fns.runQuery("posts:find", { text: "hello", tag: "b" })).toEqual(["Hello there"]);
  expect(await fns.runQuery("posts:find", { text: "wor" })).toEqual(["Hello world"]);
  await engine.close();
});
