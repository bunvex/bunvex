// The shapes of the names STUDY-180 brought to `bunvex/server` and `bunvex/values`, against Convex's own types from
// the installed `convex` 1.48.0: an app's value of one is a value of the other (assignable both ways), checked by
// `tsc` (`bun run typecheck` compiles this file). Where bunvex's type accepts more, only Convex's → bunvex's is
// checked, and the comment says why. The runtime test compares the two runtime values STUDY-180 added.
import { expect, test } from "bun:test";
import * as b from "bunvex/server";
import * as bv from "bunvex/values";
import type * as c from "convex/server";
import { SearchFilter as ConvexSearchFilter } from "convex/server";
import * as cv from "convex/values";

/** A value of `A` is a value of `B`. */
type Assignable<A, B> = [A] extends [B] ? true : false;
/** Each is assignable to the other. */
type Mutual<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

// Identity and auth.
check<Mutual<b.UserIdentity, c.UserIdentity>>(true);
check<Mutual<b.UserIdentityAttributes, c.UserIdentityAttributes>>(true);
check<Mutual<b.Auth, c.Auth>>(true);
// bunvex's `AuthProvider` also takes `type: "oidc"`, which its runtime accepts (STUDY-180 §3.1): one way.
check<Assignable<c.AuthConfig, b.AuthConfig>>(true);
check<Assignable<c.AuthProvider, b.AuthProvider>>(true);

// Pagination.
check<Mutual<b.PaginationOptions, c.PaginationOptions>>(true);
check<Equal<keyof b.PaginationOptions, keyof c.PaginationOptions>>(true);
check<Mutual<b.Cursor, c.Cursor>>(true);
check<Mutual<b.PaginationResult<{ a: number }>, c.PaginationResult<{ a: number }>>>(true);

// Function arguments and api objects.
check<Equal<b.DefaultFunctionArgs, c.DefaultFunctionArgs>>(true);
type Api = { messages: { list: b.FunctionReference<"query", "public", { a: number }, string> } };
check<Equal<b.PartialApi<Api>, c.PartialApi<Api>>>(true);
check<Equal<b.ValidatorTypeToReturnType<null>, c.ValidatorTypeToReturnType<null>>>(true);
check<
  Mutual<
    b.FunctionReference_future<"query", "public", { a: number }, string>,
    c.FunctionReference_future<"query", "public", { a: number }, string>
  >
>(true);

// The data model.
check<Equal<b.GenericIndexFields, c.GenericIndexFields>>(true);
check<Equal<b.GenericTableIndexes, c.GenericTableIndexes>>(true);
check<Equal<b.GenericSearchIndexConfig, c.GenericSearchIndexConfig>>(true);
check<Equal<b.GenericVectorIndexConfig, c.GenericVectorIndexConfig>>(true);
check<Equal<b.GenericTableSearchIndexes, c.GenericTableSearchIndexes>>(true);
check<Equal<b.GenericTableVectorIndexes, c.GenericTableVectorIndexes>>(true);
check<Equal<b.IndexTiebreakerField, c.IndexTiebreakerField>>(true);
check<Equal<b.IdField<"t">, c.IdField<"t">>>(true);
check<Mutual<b.SearchIndexConfig<"body", "kind">, c.SearchIndexConfig<"body", "kind">>>(true);
check<Mutual<b.VectorIndexConfig<"e", "kind">, c.VectorIndexConfig<"e", "kind">>>(true);
check<Mutual<b.DefineSchemaOptions<false>, c.DefineSchemaOptions<false>>>(true);
type Info = {
  document: { _id: string; _creationTime: number; kind: string; e: number[] };
  fieldPaths: "_id" | "_creationTime" | "kind" | "e";
  indexes: { by_kind: ["kind", "_creationTime"] };
  searchIndexes: { s: { searchField: "kind"; filterFields: never } };
  vectorIndexes: { v: { vectorField: "e"; dimensions: 2; filterFields: "kind" } };
};
check<Equal<b.SearchIndexes<Info>, c.SearchIndexes<Info>>>(true);
check<Equal<b.SearchIndexNames<Info>, c.SearchIndexNames<Info>>>(true);
check<Equal<b.NamedSearchIndex<Info, "s">, c.NamedSearchIndex<Info, "s">>>(true);
check<Equal<b.VectorIndexes<Info>, c.VectorIndexes<Info>>>(true);
check<Equal<b.VectorIndexNames<Info>, c.VectorIndexNames<Info>>>(true);
check<Equal<b.NamedVectorIndex<Info, "v">, c.NamedVectorIndex<Info, "v">>>(true);
type Doc = { kind: "a"; meta: { size: number } } | { kind: "b"; meta: { size: string; tag: string } } | { n: null };
check<Equal<b.FieldTypeFromFieldPath<Doc, "meta.size">, c.FieldTypeFromFieldPath<Doc, "meta.size">>>(true);
check<Equal<b.FieldTypeFromFieldPath<Doc, "meta.tag">, c.FieldTypeFromFieldPath<Doc, "meta.tag">>>(true);
check<Equal<b.FieldTypeFromFieldPath<Doc, "kind">, c.FieldTypeFromFieldPath<Doc, "kind">>>(true);
check<Equal<b.FieldTypeFromFieldPathInner<Doc, "n.x">, c.FieldTypeFromFieldPathInner<Doc, "n.x">>>(true);

// The storage interfaces: the same methods, each assignable both ways (ids are `Id<"_storage">`; Convex's
// deprecated plain-string overloads are not built, DV-543). Pending storage in mutations (DV-437, STUDY-193 §4.2):
// 1.48.0 moved `get` and `store` onto the mutation's `StorageWriter`, which bunvex's does not have yet, so only
// Convex's → bunvex's is checked there, and the two missing names are named.
check<Equal<keyof b.StorageReader, keyof c.StorageReader>>(true);
check<Equal<keyof b.StorageWriter | "get" | "store", keyof c.StorageWriter>>(true);
check<Equal<keyof b.StorageActionWriter, keyof c.StorageActionWriter>>(true);
check<Mutual<b.StorageActionWriter, c.StorageActionWriter>>(true);
check<Assignable<c.StorageWriter, b.StorageWriter>>(true);
check<Mutual<b.StorageReader, c.StorageReader>>(true);

// The schema: `SchemaDefinition`'s members, and a schema's tables. Convex's `TableDefinition` is a class with
// private members, so a schema of one is never a schema of the other: `GenericSchema` is compared by its shape, a
// record of table definitions.
check<Equal<keyof b.SchemaDefinition<b.GenericSchema, true>, keyof c.SchemaDefinition<c.GenericSchema, true>>>(true);
check<Equal<keyof b.GenericSchema, keyof c.GenericSchema>>(true);
check<Assignable<b.GenericSchema, Record<string, b.TableDefinition>>>(true);
check<Assignable<Record<string, b.TableDefinition>, b.GenericSchema>>(true);

// `bunvex/values`.
check<Equal<bv.NumericValue, cv.NumericValue>>(true);
check<Mutual<bv.ObjectFieldType, cv.ObjectFieldType>>(true);
check<Mutual<bv.RecordKeyValidatorJSON, cv.RecordKeyValidatorJSON>>(true);
check<Mutual<bv.RecordValueValidatorJSON, cv.RecordValueValidatorJSON>>(true);
check<Mutual<bv.ValidatorJSON, cv.ValidatorJSON>>(true);

test("SearchFilter and asObjectValidator: a class, and the same validator", () => {
  expect(typeof b.SearchFilter).toBe(typeof ConvexSearchFilter);
  expect(typeof b.SearchFilter).toBe("function");
  const fields = { a: bv.v.string(), b: bv.v.optional(bv.v.number()) };
  const theirs = cv.asObjectValidator({ a: cv.v.string(), b: cv.v.optional(cv.v.number()) });
  expect(bv.asObjectValidator(fields).json).toEqual((theirs as unknown as { json: bv.ValidatorJSON }).json);
  const one = bv.v.string();
  expect(bv.asObjectValidator(one)).toBe(one);
});
