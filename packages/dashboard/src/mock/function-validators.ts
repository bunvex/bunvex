// The mock functions' declared validators (STUDY-12 V1), in Convex's JSON form — what `args: { … }` and
// `returns: …` in the functions' source would serialize to. Some functions declare none, as real ones may.
import type { ObjectFieldJson, ValidatorJson } from "../data-source.ts";

const v = {
  string: (): ValidatorJson => ({ type: "string" }),
  number: (): ValidatorJson => ({ type: "number" }),
  int64: (): ValidatorJson => ({ type: "bigint" }),
  boolean: (): ValidatorJson => ({ type: "boolean" }),
  null: (): ValidatorJson => ({ type: "null" }),
  bytes: (): ValidatorJson => ({ type: "bytes" }),
  id: (tableName: string): ValidatorJson => ({ type: "id", tableName }),
  literal: (value: string | number | boolean): ValidatorJson => ({ type: "literal", value }),
  array: (value: ValidatorJson): ValidatorJson => ({ type: "array", value }),
  union: (...value: ValidatorJson[]): ValidatorJson => ({ type: "union", value }),
  object: (fields: Record<string, ValidatorJson | ObjectFieldJson>): ValidatorJson => ({
    type: "object",
    value: Object.fromEntries(
      Object.entries(fields).map(([k, f]) => [k, "fieldType" in f ? f : { fieldType: f, optional: false }]),
    ),
  }),
  optional: (fieldType: ValidatorJson): ObjectFieldJson => ({ fieldType, optional: true }),
};

const system = (table: string) => ({ _id: v.id(table), _creationTime: v.number() });
const fields = {
  users: { name: v.string(), email: v.string(), admin: v.boolean(), credits: v.int64() },
  tasks: { text: v.string(), done: v.boolean(), owner: v.id("users"), priority: v.number(), tags: v.array(v.string()) },
  messages: {
    author: v.id("users"),
    channel: v.string(),
    body: v.string(),
    meta: v.union(v.null(), v.object({ edited: v.boolean(), editedAt: v.number() })),
  },
};
const user = v.object({ ...system("users"), ...fields.users });
const task = v.object({ ...system("tasks"), ...fields.tasks });
const message = v.object({ ...system("messages"), ...fields.messages });

/** The schema's declared document types (STUDY-12 V2): without the system fields, as a schema writes them. */
export const MOCK_DOCUMENT_TYPES: Record<string, ValidatorJson> = {
  users: v.object(fields.users),
  tasks: v.object(fields.tasks),
  messages: v.object(fields.messages),
};
const priority = v.union(...[1, 2, 3, 4, 5].map((n) => v.literal(n)));

/** By path; a function missing here declares no validators. */
export const MOCK_VALIDATORS: Record<string, { args?: ValidatorJson; returns?: ValidatorJson }> = {
  "messages:list": {
    args: v.object({ channel: v.optional(v.string()), limit: v.optional(v.number()) }),
    returns: v.array(message),
  },
  "messages:send": { args: v.object({ channel: v.string(), body: v.string() }), returns: v.null() },
  "messages:purgeOld": { args: v.object({ olderThanDays: v.number() }), returns: v.null() },
  "tasks:list": { args: v.object({ limit: v.optional(v.number()) }), returns: v.array(task) },
  "tasks:byOwner": { args: v.object({ owner: v.id("users") }), returns: v.array(task) },
  "tasks:create": { args: v.object({ text: v.string(), priority: v.optional(priority) }) },
  "tasks:toggle": { args: v.object({ id: v.id("tasks") }), returns: v.null() },
  "users:get": { args: v.object({ id: v.id("users") }), returns: v.union(v.null(), user) },
  "users:upsert": {
    args: v.object({
      email: v.string(),
      name: v.string(),
      admin: v.optional(v.boolean()),
      credits: v.optional(v.int64()),
    }),
    returns: v.null(),
  },
  // tasks:summarize and users:syncFromAuth declare none
};
