// The data model's types (STUDY-36): checked by `tsc` (`bun run typecheck`), as Convex's; each `Equal` must
// hold and each `@ts-expect-error` must be an error. The test below only keeps bun:test from finding none.
import { expect, test } from "bun:test";
import { type GenericId, v } from "@bunvex/values";
import type {
  AnyDataModel,
  DataModelFromSchemaDefinition,
  DocumentByName,
  NamedIndex,
  TableNamesInDataModel,
  WithOptionalSystemFields,
  WithoutSystemFields,
} from "../../src/data-model.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

const schema = defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.optional(v.string()),
    address: v.object({ city: v.string() }),
  }).index("by_name", ["name"]),
  messages: defineTable({ author: v.id("users"), body: v.string(), tags: v.array(v.string()) })
    .index("by_author", ["author"])
    .index("by_author_body", { fields: ["author", "body"], staged: true }),
  events: defineTable(
    v.union(v.object({ kind: v.literal("a"), a: v.number() }), v.object({ kind: v.literal("b"), b: v.string() })),
  ),
  loose: defineTable(v.any()),
});
type DataModel = DataModelFromSchemaDefinition<typeof schema>;

check<Equal<TableNamesInDataModel<DataModel>, "users" | "messages" | "events" | "loose">>(true);
type Message = DocumentByName<DataModel, "messages">;
check<
  Equal<
    Message,
    { _id: GenericId<"messages">; _creationTime: number; author: GenericId<"users">; body: string; tags: string[] }
  >
>(true);
type User = DocumentByName<DataModel, "users">;
check<Equal<User["email"], string | undefined>>(true);
check<Equal<DataModel["users"]["fieldPaths"], "_id" | "_creationTime" | "name" | "email" | "address" | "address.city">>(
  true,
);
// An optional field is a path, never `undefined`.
check<Equal<undefined extends DataModel["users"]["fieldPaths"] ? true : false, false>>(true);
check<Equal<NamedIndex<DataModel["messages"], "by_author">, ["author", "_creationTime"]>>(true);
check<Equal<NamedIndex<DataModel["messages"], "by_author_body">, ["author", "body", "_creationTime"]>>(true);
check<Equal<NamedIndex<DataModel["users"], "by_id">, ["_id"]>>(true);
// A union table: system fields on each branch.
type Event = DocumentByName<DataModel, "events">;
check<Equal<Extract<Event, { kind: "b" }>["_id"], GenericId<"events">>>(true);
// v.any() tables hold any document.
// biome-ignore lint/suspicious/noExplicitAny: the expected type is any
check<Equal<DocumentByName<DataModel, "loose">, any>>(true);
check<Equal<WithoutSystemFields<Message>, { author: GenericId<"users">; body: string; tags: string[] }>>(true);
check<Equal<WithOptionalSystemFields<Message>["_id"], GenericId<"messages"> | undefined>>(true);
// Strict table names by default; `strictTableNameTypes: false` allows any table as AnyDataModel.
// @ts-expect-error not a table of the schema
type _NoSuchTable = DocumentByName<DataModel, "nope">;
const loose = defineSchema({ a: defineTable({ x: v.number() }) }, { strictTableNameTypes: false });
type Loose = DataModelFromSchemaDefinition<typeof loose>;
check<Equal<DocumentByName<Loose, "a">["x"], number>>(true);
type _Other = DocumentByName<Loose, "anything">;
check<Equal<AnyDataModel[string]["indexes"], {}>>(true);
// Ids of different tables do not mix.
const userId = "u" as GenericId<"users">;
// @ts-expect-error a users id is not a messages id
const _wrong: GenericId<"messages"> = userId;
// `.staged()` (STUDY-106) changes neither the document type nor the indexes, as Convex's.
const withStaged = defineSchema({
  drafts: defineTable({ author: v.string() })
    .index("by_author", ["author"])
    .staged({ author: v.array(v.string()) }),
  notes: defineTable({ body: v.string() }).staged(v.object({ body: v.string(), done: v.boolean() })),
});
type Staged = DataModelFromSchemaDefinition<typeof withStaged>;
check<Equal<DocumentByName<Staged, "drafts">, { _id: GenericId<"drafts">; _creationTime: number; author: string }>>(
  true,
);
check<Equal<DocumentByName<Staged, "notes">, { _id: GenericId<"notes">; _creationTime: number; body: string }>>(true);
check<Equal<NamedIndex<Staged["drafts"], "by_author">, ["author", "_creationTime"]>>(true);
// @ts-expect-error a staged validator is an object's: a string validator is refused
defineTable({ a: v.string() }).staged(v.string());
// The runtime is unchanged: the same declared tables.
test("the schema's runtime shape is unchanged by its types", () => {
  expect([...schema.tables.keys()]).toEqual(["users", "messages", "events", "loose"]);
  expect(schema.tables.get("messages")!.indexes).toEqual({ by_author: ["author"], by_author_body: ["author", "body"] });
  expect(schema.tables.get("messages")!.staged).toEqual(["by_author_body"]);
});
