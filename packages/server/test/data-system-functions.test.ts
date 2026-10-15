// The Data screen's reads (STUDY-149 PR 2), where Convex's local backend is not needed to tell (the oracle is
// packages/differential/test/dashboard-data.test.ts): the table mapping's system tables, staged, search and
// vector indexes, and the search-index path of `paginatedTableDocuments`.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, SCHEMAS_TABLE, schemaJsonText } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { UNDEFINED_PLACEHOLDER } from "../src/data-system-functions.ts";
import { Functions, mutation } from "../src/functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const schema = defineSchema({
    posts: defineTable({ title: v.string(), tag: v.string(), n: v.optional(v.number()) })
      .index("by_tag", ["tag"])
      .index("by_n", { fields: ["n"], staged: true })
      .searchIndex("search_title", { searchField: "title", filterFields: ["tag"] })
      .vectorIndex("by_vec", { vectorField: "vec", dimensions: 2, filterFields: ["tag"] }),
    other: defineTable(v.any()),
  });
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    storedSchema: true,
  }).init();
  stops.push(() => engine.close());
  // the schema a push would have made active (the search path reads the active schema's indexes, as Convex's)
  await engine.mutation((db) =>
    db.asSystem(() => db.insert(SCHEMAS_TABLE, { state: { state: "active" }, schema: schemaJsonText(schema) })),
  );
  await engine.searchReady();
  const functions = new Functions(engine).register("posts", {
    add: mutation(async ({ db }, doc: Record<string, unknown>) => db.insert("posts", doc)),
  });
  const sys = (name: string, args: Record<string, unknown> = {}) =>
    functions.runSystemQuery(`_system/frontend/${name}`, args) as Promise<never>;
  const page = (filters: unknown, numItems = 10) =>
    sys("paginatedTableDocuments", {
      table: "posts",
      filters: filters === null ? null : Buffer.from(JSON.stringify(filters)).toString("base64url"),
      paginationOpts: { numItems, cursor: null },
    }) as Promise<{ page: Record<string, unknown>[]; isDone: boolean }>;
  return { engine, functions, sys, page };
}

describe("getTableMapping", () => {
  test("the user tables and the two system tables ids link to, by number", async () => {
    const { sys } = await setup();
    const mapping = (await sys("getTableMapping")) as Record<string, string>;
    const names = Object.values(mapping);
    expect(names.filter((n) => !n.startsWith("_")).sort()).toEqual(["other", "posts"]);
    expect(names.filter((n) => n.startsWith("_")).sort()).toEqual(["_file_storage", "_scheduled_jobs"]);
    const numbers = Object.keys(mapping).map(Number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  });
});

describe("indexes", () => {
  test("database, staged, search and vector indexes in Convex's shapes", async () => {
    const { sys } = await setup();
    const got = ((await sys("indexes", { tableName: "posts", tableNamespace: null })) as { name: string }[]).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    expect(got).toEqual([
      { name: "by_n", staged: true, fields: ["n", "_creationTime"], backfill: { state: "backfilled" } },
      { name: "by_tag", staged: false, fields: ["tag", "_creationTime"], backfill: { state: "done" } },
      {
        name: "by_vec",
        staged: false,
        fields: { vectorField: "vec", filterFields: ["tag"], dimensions: 2 },
        backfill: { state: "done" },
      },
      {
        name: "search_title",
        staged: false,
        fields: { searchField: "title", filterFields: ["tag"] },
        backfill: { state: "done" },
      },
    ] as never);
  });
});

describe("paginatedTableDocuments", () => {
  test("a search index: its text and filter fields, ascending only, its filter fields only", async () => {
    const { functions, page } = await setup();
    await functions.runMutation("posts:add", { title: "hello world", tag: "a" });
    await functions.runMutation("posts:add", { title: "hello there", tag: "b" });
    await functions.runMutation("posts:add", { title: "goodbye", tag: "a" });
    const search = (clauses: unknown[], order = "asc", more: unknown[] = []) =>
      page({ clauses: more, order, index: { name: "search_title", search: "hello", clauses } });
    expect((await search([])).page.map((d) => d.title).sort()).toEqual(["hello there", "hello world"]);
    expect((await search([{ field: "tag", enabled: true, value: "b" }])).page.map((d) => d.title)).toEqual([
      "hello there",
    ]);
    // a disabled filter field is not applied
    expect((await search([{ field: "tag", enabled: false, value: "b" }])).page).toHaveLength(2);
    // field filters after the search
    const filtered = await search([], "asc", [{ field: "tag", op: "eq", value: "a", enabled: true }]);
    expect(filtered.page.map((d) => d.title)).toEqual(["hello world"]);
    expect((await search([], "desc")).page).toEqual([
      { filter: -1, error: "Trying to query search index `search_title` in descending order." },
    ] as never);
    expect((await search([{ field: "title", enabled: true, value: "x" }])).page).toEqual([
      {
        filter: 0,
        error:
          "Invalid index filter selection: found a filter for field `title` which is not part of the filter fields of the search index `search_title`.",
      },
    ] as never);
    expect(
      (
        await search([
          { field: "tag", enabled: true, value: "a" },
          { field: "tag", enabled: true, value: "b" },
        ])
      ).page,
    ).toEqual([{ filter: 0, error: "Invalid filter: there are multiple filters for field `tag`." }] as never);
    // a search index used as a database index, and a staged index (not in the schema's indexes)
    for (const name of ["search_title", "by_n"])
      expect((await page({ clauses: [], order: "asc", index: { name, clauses: [] } })).page[0]).toMatchObject({
        filter: -1,
      });
  });

  test("the undefined placeholder: a field the document does not have", async () => {
    const { functions, page } = await setup();
    await functions.runMutation("posts:add", { title: "one", tag: "a", n: 1 });
    await functions.runMutation("posts:add", { title: "two", tag: "a" });
    const where = (op: string) => page({ clauses: [{ field: "n", op, value: UNDEFINED_PLACEHOLDER }], order: "asc" });
    expect((await where("eq")).page.map((d) => d.title)).toEqual(["two"]);
    expect((await where("neq")).page.map((d) => d.title)).toEqual(["one"]);
    // Convex's own placeholder is an ordinary string here (rule 5, DV-478)
    const convex = UNDEFINED_PLACEHOLDER.replace("BUNVEX", "CONVEX");
    expect((await page({ clauses: [{ field: "n", op: "eq", value: convex }], order: "asc" })).page).toEqual([]);
  });

  test("filters as base64 or base64url, with or without padding", async () => {
    const { functions, sys } = await setup();
    await functions.runMutation("posts:add", { title: "é", tag: "ü" });
    const expr = JSON.stringify({ clauses: [{ field: "tag", op: "eq", value: "ü", enabled: true }] });
    for (const filters of [
      Buffer.from(expr).toString("base64"),
      Buffer.from(expr).toString("base64url"),
      Buffer.from(expr).toString("base64").replace(/=+$/, ""),
    ]) {
      const r = (await sys("paginatedTableDocuments", {
        table: "posts",
        filters,
        paginationOpts: { numItems: 5, cursor: null },
      })) as { page: { title: string }[] };
      expect(r.page.map((d) => d.title)).toEqual(["é"]);
    }
  });
});
