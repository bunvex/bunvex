// The names STUDY-180 brought to Convex's shape, from the package's index as an app imports them: checked by `tsc`
// (`bun run typecheck`), and `SearchFilter` at run time. Their shapes against Convex's own types are compared by
// packages/differential/test/api-shapes.test.ts.
import { expect, test } from "bun:test";
import { Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { type asObjectValidator, type GenericId, type VId, type VOptional, type VString, v } from "@bunvex/values";
import {
  type ActionBuilder,
  actionGeneric,
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  type Expression,
  type ExpressionOrValue,
  type FieldTypeFromFieldPath,
  Functions,
  type MutationBuilder,
  mutationGeneric,
  type PaginationOptions,
  type QueryBuilder,
  queryGeneric,
  type SchemaDefinition,
  SearchFilter,
  type StorageActionWriter,
  type StorageReader,
  type StorageWriter,
  type VectorIndexNames,
  type VectorSearch,
} from "../../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

const schema = defineSchema({
  notes: defineTable({ body: v.string(), kind: v.string(), team: v.string(), embedding: v.array(v.number()) })
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 2, filterFields: ["kind"] }),
});
type DM = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DM, "public">;
const mutation = mutationGeneric as MutationBuilder<DM, "public">;
const action = actionGeneric as ActionBuilder<DM, "public">;

// `ctx.storage`: a query's and a mutation's offer no `store` (Convex's `StorageReader` / `StorageWriter`); ids are
// `Id<"_storage">`.
export const storageTypes = {
  inQuery: query(async (ctx) => {
    check<Equal<typeof ctx.storage, StorageReader>>(true);
    // @ts-expect-error a query's storage has no `store`
    await ctx.storage.store(new Blob(["x"]));
    // @ts-expect-error nor `generateUploadUrl`
    await ctx.storage.generateUploadUrl();
    // @ts-expect-error a plain string is not a file's id
    await ctx.storage.getUrl("not-an-id");
  }),
  inMutation: mutation(async (ctx, { id }: { id: GenericId<"_storage"> }) => {
    check<Equal<typeof ctx.storage, StorageWriter>>(true);
    // @ts-expect-error a mutation's storage has no `store`
    await ctx.storage.store(new Blob(["x"]));
    await ctx.storage.delete(id);
    return await ctx.storage.getUrl(id);
  }),
  inAction: action(async (ctx) => {
    check<Equal<typeof ctx.storage, StorageActionWriter>>(true);
    const id = await ctx.storage.store(new Blob(["x"]));
    check<Equal<typeof id, GenericId<"_storage">>>(true);
    return await ctx.storage.get(id);
  }),
};

// `ctx.vectorSearch`: the index is one of the table's vector indexes, and a filter names its filter fields only,
// with their values' types (Convex's `VectorSearch`, `VectorFilterBuilder`).
check<Equal<VectorIndexNames<DM["notes"]>, "by_embedding">>(true);
export const vectorTypes = action(async (ctx) => {
  const search: VectorSearch<DM, "notes", "by_embedding"> = ctx.vectorSearch;
  await search("notes", "by_embedding", { vector: [1, 0], filter: (q) => q.eq("kind", "a") });
  // @ts-expect-error `team` is a field of the table, not one of the index's filter fields
  await ctx.vectorSearch("notes", "by_embedding", { vector: [1, 0], filter: (q) => q.eq("team", "a") });
  // @ts-expect-error a filter field's value has its field's type
  await ctx.vectorSearch("notes", "by_embedding", { vector: [1, 0], filter: (q) => q.eq("kind", 1) });
  // @ts-expect-error not a vector index of the table
  await ctx.vectorSearch("notes", "search_body", { vector: [1, 0] });
  const hits = await ctx.vectorSearch("notes", "by_embedding", { vector: [1, 0], limit: 3 });
  check<Equal<typeof hits, Array<{ _id: GenericId<"notes">; _score: number }>>>(true);
});

// `SchemaDefinition`: Convex's type parameters (no defaults), with `doc` and `id`.
check<Equal<typeof schema, SchemaDefinition<typeof schema.tables, true>>>(true);
check<Equal<ReturnType<typeof schema.id<"notes">>, VId<GenericId<"notes">>>>(true);
check<Equal<ReturnType<typeof schema.doc<"notes">>["type"]["_id"], GenericId<"notes">>>(true);
check<Equal<(typeof schema)["strictTableNameTypes"], true>>(true);
// @ts-expect-error a table the schema does not declare (a type check only: it throws at run time)
export const otherTable = () => schema.id("other");

// `FieldTypeFromFieldPath`: over each member of a union of documents, `undefined` where one lacks the field.
type Union = { kind: "a"; meta: { size: number } } | { kind: "b"; meta: { size: string; tag: string } };
check<Equal<FieldTypeFromFieldPath<Union, "meta.size">, number | string>>(true);
check<Equal<FieldTypeFromFieldPath<Union, "meta.tag">, string | undefined>>(true);
check<Equal<FieldTypeFromFieldPath<Union, "kind">, "a" | "b">>(true);
check<Equal<FieldTypeFromFieldPath<{ a?: { b: boolean } }, "a.b">, boolean | undefined>>(true);

// `ExpressionOrValue`: Convex's, an expression of `T` or a `T`.
check<Equal<ExpressionOrValue<boolean>, Expression<boolean> | boolean>>(true);

// `PaginationOptions` has no `id` (the validator still takes it, as Convex's).
check<Equal<keyof PaginationOptions, "numItems" | "cursor" | "endCursor" | "maximumRowsRead" | "maximumBytesRead">>(
  true,
);

// `@bunvex/values`: `v.optional` gives `VOptional`, `asObjectValidator` an object validator's type.
check<Equal<ReturnType<typeof v.optional<VString<string>>>, VOptional<VString<string>>>>(true);
check<Equal<VOptional<VString<string>>, VString<string | undefined, "optional">>>(true);
check<Equal<ReturnType<typeof asObjectValidator<{ a: VString<string> }>>["type"], { a: string }>>(true);

test("SearchFilter is a class, and what a search filter builder returns is one", async () => {
  expect(typeof SearchFilter).toBe("function");
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await engine.searchReady();
  const functions = new Functions(engine).register("m", {
    filters: query(async (ctx) => {
      const seen: unknown[] = [];
      await ctx.db
        .query("notes")
        .withSearchIndex("search_body", (q) => {
          const searched = q.search("body", "x");
          const filtered = searched.eq("kind", "a");
          seen.push(q, searched, filtered);
          return filtered;
        })
        .collect();
      return seen.map((x) => x instanceof SearchFilter);
    }),
  });
  expect(await functions.runQuery("m:filters", {})).toEqual([true, true, true]);
});

// Abstract, as Convex's: an app cannot make one of its own.
// @ts-expect-error an abstract class
export const ownFilter = () => new SearchFilter();
