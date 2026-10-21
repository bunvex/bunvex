// convex-helpers' `server/validators.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 1): the validators as
// function `args` and `returns` and as a schema, `doc` / `typedV`, `addFieldsToValidator`, `validate` (ids against
// the database included), `parse` and `partial`. Upstream runs the functions on convex-test; here they run on
// bunvex's real engine in memory (an Engine and `Functions`, until `@bunvex/testing` lands). The type assertions
// (vitest's `expectTypeOf` / `assertType`) are `Equals` checks and assignments, which `tsc` runs.
//
// Where it differs from upstream:
// - convex-test words an argument mismatch "Validator error…" (its own validator, not Convex's); bunvex's engine, as
//   Convex's, says "ArgumentValidationError: …", which the "disallow" test expects.
// - `validate` with `db` on a system table's id uses `_scheduled_functions` (a scheduled call's id): convex-test's
//   `ctx.storage.store` in `t.run` has no counterpart without a file store. A fake `db` checks `_storage` goes through
//   `db.system.normalizeId` too.
// biome-ignore-all lint/suspicious/noExplicitAny: the ported tests use `any` as convex-helpers' do
import { describe, expect, test } from "bun:test";
import { Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  Functions,
  type GenericDatabaseReader,
  type GenericMutationCtx,
  internalMutationGeneric,
  internalQueryGeneric,
  type MutationBuilder,
  type QueryBuilder,
} from "@bunvex/server";
import { type GenericId, type Infer, type ObjectType, type VString, v } from "@bunvex/values";
import { type Equals, type Expand, nullThrows } from "../../src/index.ts";
import {
  addFieldsToValidator,
  brandedString,
  deprecated,
  doc,
  literals,
  nullable,
  parse,
  partial,
  pretend,
  pretendRequired,
  typedV,
  ValidationError,
  validate,
} from "../../src/validators.ts";

/** A type assertion: compiles only when `T` is `true`. */
const check = <T extends true>(_?: T) => {};

const fail = (message: string): never => {
  throw new Error(message);
};

export const testLiterals = internalQueryGeneric({
  args: { foo: literals("bar", "baz") },
  handler: async (_ctx, args) => {
    const foo: "bar" | "baz" = args.foo;
    return foo;
  },
});

const emailValidator = brandedString("email");
type Email = Infer<typeof emailValidator>;

const ExampleFields = {
  // These look like types, but they're values.
  name: v.string(),
  age: v.number(),
  nickname: v.optional(v.string()),
  id: v.optional(v.id("users")),
  balance: nullable(v.int64()),
  ephemeral: v.boolean(),
  status: literals("active", "inactive"),
  rawJSON: v.optional(v.any()),
  maybeNotSetYet: pretendRequired(v.string()),
  couldBeAnything: pretend(v.boolean()),
  loginType: v.union(
    v.object({ type: v.literal("email"), email: emailValidator, phone: v.null(), verified: v.boolean() }),
    v.object({ type: v.literal("phone"), phone: v.string(), email: v.null(), verified: v.boolean() }),
  ),
  logs: v.union(v.string(), v.array(v.string())),

  // This is a handy way to mark a field as deprecated
  oldField: deprecated,
};
type ExampleFields = ObjectType<typeof ExampleFields>;

export const echo = internalQueryGeneric({
  args: ExampleFields,
  handler: async (_ctx, args) => args,
});

const valid = {
  name: "test",
  age: 5,
  nickname: "nick",
  balance: 100n,
  ephemeral: true,
  status: "active" as const,
  rawJSON: { foo: "bar" },
  maybeNotSetYet: "set",
  couldBeAnything: true,
  loginType: { type: "email", email: "foo@bar.com" as Email, phone: null, verified: true } as const,
  logs: ["log1", "log2"],
  oldField: "foo" as any,
};

const schema = defineSchema({
  users: defineTable({ tokenIdentifier: v.string() }),
  kitchenSink: defineTable(ExampleFields),
  unionTable: defineTable(v.union(v.object({ foo: v.string() }), v.object({ bar: v.number() }))),
});
type DM = DataModelFromSchemaDefinition<typeof schema>;

const internalMutation = internalMutationGeneric as MutationBuilder<DM, "internal">;
const internalQuery = internalQueryGeneric as QueryBuilder<DM, "internal">;

export const toDoc = internalMutation({
  args: {},
  handler: async (ctx) => {
    const kid = await ctx.db.insert("kitchenSink", valid);
    const uid = await ctx.db.insert("unionTable", { foo: "" });
    return {
      sink: nullThrows(await ctx.db.get("kitchenSink", kid)),
      union: nullThrows(await ctx.db.get("unionTable", uid)),
    };
  },
  returns: v.object({ sink: doc(schema, "kitchenSink"), union: doc(schema, "unionTable") }),
});

const vv = typedV(schema);

export const getSink = internalQuery({
  args: { docId: vv.id("kitchenSink") },
  returns: nullable(vv.doc("kitchenSink")),
  handler: (ctx, args) => ctx.db.get("kitchenSink", args.docId),
});

export const getUnion = internalQuery({
  args: { docId: vv.id("unionTable") },
  returns: nullable(vv.doc("unionTable")),
  handler: (ctx, args) => ctx.db.get("unionTable", args.docId),
});

/** The body `t.run` runs (convex-test's), as one internal mutation. */
let body: ((ctx: GenericMutationCtx<DM>) => Promise<unknown>) | null = null;
export const run = internalMutation({ args: {}, handler: async (ctx) => (await body!(ctx)) ?? null });

/** convex-test's `convexTest(schema, modules)`: a fresh engine in memory with this module's functions. */
async function bunvexTest() {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const fns = new Functions(engine).register("validators", { testLiterals, echo, toDoc, getSink, getUnion, run });
  return {
    query: (name: string, args: object) => fns.runQuery(`validators:${name}`, args, false),
    mutation: (name: string, args: object) => fns.runMutation(`validators:${name}`, args, false),
    run: async <T>(fn: (ctx: GenericMutationCtx<DM>) => Promise<T>): Promise<T> => {
      body = fn;
      try {
        return (await fns.runMutation("validators:run", {}, false)) as T;
      } finally {
        body = null;
      }
    },
  };
}

test("vv generates the right types for objects", async () => {
  const t = await bunvexTest();
  const docId = await t.run((ctx) => ctx.db.insert("kitchenSink", valid));
  const doc = (await t.query("getSink", { docId })) as Infer<ReturnType<typeof vv.doc<"kitchenSink">>> | null;
  expect(doc).toBeDefined();
  expect(doc!._creationTime).toBeTypeOf("number");
  check<Equals<(typeof doc & {})["_creationTime"], number>>();
  check<Equals<(typeof doc & {})["_id"], GenericId<"kitchenSink">>>();
});

test("literals as args", async () => {
  const t = await bunvexTest();
  expect(await t.query("testLiterals", { foo: "baz" })).toBe("baz");
  await expect(t.query("testLiterals", { foo: "qux" })).rejects.toThrow("ArgumentValidationError");
  check<Equals<Infer<ReturnType<typeof literals<["bar", "baz"]>>>, "bar" | "baz">>();
});

describe("addFieldsToValidator", () => {
  test("adds fields to a property validator", () => {
    const validator = addFieldsToValidator({ foo: v.string() }, { bar: v.string() });
    check<Equals<typeof validator.fields, { foo: VString } & { bar: VString }>>();
    expect(validator.fields.bar).toBeDefined();
    expect(validate(validator, { foo: "foo", bar: "bar" })).toBe(true);
    expect(validate(v.object(validator.fields), { foo: "foo" })).toBe(false);
  });
  test("adds fields to an object validator", () => {
    const validator = v.object({ foo: v.string() });
    const rawValidator = addFieldsToValidator(validator, { bar: v.string() });
    check<Equals<(typeof rawValidator)["type"], { foo: string } & { bar: string }>>();
    check<Equals<typeof rawValidator.kind, "object">>();
    const newValidator: any = rawValidator;
    expect(newValidator.fields.bar).toBeDefined();
    expect(validate(newValidator, { foo: "foo", bar: "bar" })).toBe(true);
  });
  test("adds fields to a union validator", () => {
    const validator = v.union(v.object({ foo: v.string() }), v.object({ bar: v.string() }));
    const rawValidator = addFieldsToValidator(validator, { baz: v.string() });
    check<Equals<(typeof rawValidator)["type"], { foo: string; baz: string } | { bar: string; baz: string }>>();
    const newValidator: any = rawValidator;
    expect(newValidator.members[0]!.fields.baz).toBeDefined();
    expect(newValidator.members[1]!.fields.baz).toBeDefined();
    expect(validate(newValidator, { foo: "foo", baz: "baz" })).toBe(true);
    expect(validate(newValidator, { bar: "bar", baz: "baz" })).toBe(true);
  });
  test("adds fields to a union of objects and unions", () => {
    const validator = v.union(
      v.object({ foo: v.string() }),
      v.union(v.object({ bar: v.string() }), v.object({ baz: v.string() })),
    );
    const newValidator: any = addFieldsToValidator(validator, { qux: v.string() });
    expect(newValidator.members[0]!.fields.qux).toBeDefined();
    expect(newValidator.members[1]!.members[0]!.fields.qux).toBeDefined();
    expect(newValidator.members[1]!.members[1]!.fields.qux).toBeDefined();
    expect(validate(newValidator, { foo: "foo", qux: "qux" })).toBe(true);
    expect(validate(newValidator, { bar: "bar", qux: "qux" })).toBe(true);
    expect(validate(newValidator, { baz: "baz", qux: "qux" })).toBe(true);
  });

  // Not in upstream's test: the branches of convex-helpers' code it does not reach.
  test("no fields: the validator as it is (fields as their object validator)", () => {
    const object = v.object({ foo: v.string() });
    expect(addFieldsToValidator(object, {})).toBe(object);
    const fromFields = addFieldsToValidator({ foo: v.string() }, {});
    expect(fromFields.kind).toBe("object");
    expect(fromFields.json).toEqual(object.json);
  });
  test("a field in both: the same kind required, the required one wins", () => {
    const merged: any = addFieldsToValidator(v.object({ a: v.optional(v.string()), b: v.string() }), {
      a: v.string(),
      b: v.optional(v.string()),
    });
    expect(merged.fields.a.isOptional).toBe("required");
    expect(merged.fields.b.isOptional).toBe("required");
    expect(() => addFieldsToValidator(v.object({ a: v.string() }), { a: v.number() })).toThrow(
      new Error("Cannot intersect validators with different kinds: string and float64"),
    );
  });
  test("a validator that is not an object or a union is refused", () => {
    expect(() => addFieldsToValidator(v.string() as any, { a: v.string() })).toThrow(
      new Error("Cannot add arguments to a validator that is not an object or union."),
    );
    expect(() => addFieldsToValidator(v.union(v.object({}), v.string()) as any, { a: v.string() })).toThrow(
      "Cannot add arguments to a validator that is not an object or union.",
    );
  });
});

test("vv generates the right types for unions", async () => {
  const t = await bunvexTest();
  const docId = await t.run((ctx) => ctx.db.insert("unionTable", { foo: "foo" }));
  const doc = (await t.query("getUnion", { docId })) as Infer<ReturnType<typeof vv.doc<"unionTable">>> | null;
  expect(doc).toBeDefined();
  expect(doc!._creationTime).toBeTypeOf("number");
  expect("foo" in doc! && !!doc!.foo).toBe(true);
});

test("doc validator adds fields", async () => {
  const t = await bunvexTest();
  await t.mutation("toDoc", {});
  const userDoc = doc(schema, "users");
  expect(userDoc.fields.tokenIdentifier).toBeDefined();
  expect(userDoc.fields._id).toBeDefined();
  expect(userDoc.fields._creationTime).toBeDefined();
  const unionDoc = doc(schema, "unionTable");
  expect(unionDoc.kind).toBe("union");
  if (unionDoc.kind !== "union") throw new Error("Expected union");
  expect(unionDoc.members[0]!.kind).toBe("object");
  if (unionDoc.members[0]!.kind !== "object") throw new Error("Expected object");
  expect(unionDoc.members[0]!.fields.foo).toBeDefined();
  expect(unionDoc.members[0]!.fields._id).toBeDefined();
  expect(unionDoc.members[0]!.fields._creationTime).toBeDefined();
  if (unionDoc.members[1]!.kind !== "object") throw new Error("Expected object");
  expect(unionDoc.members[1]!.fields.bar).toBeDefined();
  expect(unionDoc.members[1]!.fields._id).toBeDefined();
  expect(unionDoc.members[1]!.fields._creationTime).toBeDefined();
});

test("doc refuses a table validator that is not an object or a union", () => {
  const anySchema = defineSchema({ loose: defineTable(v.any()) });
  expect(() => doc(anySchema, "loose")).toThrow(
    new Error("Only object and union validators are supported for documents"),
  );
});

test("validators preserve things when they're set", async () => {
  const t = await bunvexTest();
  const id = await t.run((ctx) => ctx.db.insert("users", { tokenIdentifier: "" }));
  // when everything is set
  const obj = { ...valid, id };
  const result = await t.query("echo", obj);
  expect(result).toMatchObject(obj);
});

test("validators allow things when they're unset", async () => {
  const t = await bunvexTest();
  // optional things are unset
  const obj = {
    name: "test",
    age: 5,
    balance: null,
    ephemeral: true,
    status: "inactive",
    couldBeAnything: true,
    loginType: { type: "phone", email: null, phone: "", verified: false } as const,
    logs: "log",
  } as ExampleFields;
  const result = await t.query("echo", obj);
  expect(result).toMatchObject(obj);
});

test("validators disallow things when they're wrong", async () => {
  const t = await bunvexTest();
  await expect(t.query("echo", {} as ExampleFields)).rejects.toThrow("ArgumentValidationError");
  // extra field
  await expect(t.query("echo", { ...valid, unknown: 3 } as ExampleFields)).rejects.toThrow("ArgumentValidationError");
  // pretend required shouldn't allow other types
  await expect(
    t.query("echo", { ...valid, maybeNotSetYet: true as unknown as string } as ExampleFields),
  ).rejects.toThrow("ArgumentValidationError");
});

describe("validate", () => {
  test("validates primitive validators", () => {
    // String
    expect(validate(v.string(), "hello")).toBe(true);
    expect(validate(v.string(), 123)).toBe(false);
    expect(validate(v.string(), null)).toBe(false);

    // Number
    expect(validate(v.number(), 123)).toBe(true);
    expect(validate(v.number(), "123")).toBe(false);
    expect(validate(v.number(), null)).toBe(false);

    // Boolean
    expect(validate(v.boolean(), true)).toBe(true);
    expect(validate(v.boolean(), false)).toBe(true);
    expect(validate(v.boolean(), "true")).toBe(false);
    expect(validate(v.boolean(), 1)).toBe(false);

    // Null
    expect(validate(v.null(), null)).toBe(true);
    expect(validate(v.null(), undefined)).toBe(false);
    expect(validate(v.null(), false)).toBe(false);

    // BigInt/Int64
    expect(validate(v.int64(), 123n)).toBe(true);
    expect(validate(v.int64(), 123)).toBe(false);
    expect(validate(v.int64(), "123")).toBe(false);
  });

  test("validates array validator", () => {
    const arrayOfStrings = v.array(v.string());
    expect(validate(arrayOfStrings, ["a", "b", "c"])).toBe(true);
    expect(validate(arrayOfStrings, [])).toBe(true);
    expect(validate(arrayOfStrings, ["a", 1, "c"])).toBe(false);
    expect(validate(arrayOfStrings, null)).toBe(false);
    expect(validate(arrayOfStrings, "not an array")).toBe(false);
  });

  test("validates object validator", () => {
    const personValidator = v.object({ name: v.string(), age: v.number(), optional: v.optional(v.string()) });

    expect(validate(personValidator, { name: "Alice", age: 30 })).toBe(true);
    expect(validate(personValidator, { name: "Bob", age: 25, optional: "test" })).toBe(true);
    expect(validate(personValidator, { name: "Charlie", age: "30" })).toBe(false);
    expect(validate(personValidator, { name: "Dave" })).toBe(false);
    expect(validate(personValidator, null)).toBe(false);
    expect(validate(personValidator, { name: "Eve", age: 20, extra: "field" })).toBe(false);
  });

  test("validates union validator", () => {
    const unionValidator = v.union(v.string(), v.number(), v.object({ type: v.literal("test") }));

    expect(validate(unionValidator, "string")).toBe(true);
    expect(validate(unionValidator, 123)).toBe(true);
    expect(validate(unionValidator, { type: "test" })).toBe(true);
    expect(validate(unionValidator, { type: "wrong" })).toBe(false);
    expect(validate(unionValidator, true)).toBe(false);
    expect(validate(unionValidator, null)).toBe(false);
  });

  test("validates literal validator", () => {
    const literalValidator = v.literal("specific");
    expect(validate(literalValidator, "specific")).toBe(true);
    expect(validate(literalValidator, "other")).toBe(false);
    expect(validate(literalValidator, null)).toBe(false);
  });

  test("validates union of literals", () => {
    const unionValidator = v.union(v.literal("foo"), v.literal("bar"));
    expect(validate(unionValidator, "foo")).toBe(true);
    expect(validate(unionValidator, "bar")).toBe(true);
    expect(validate(unionValidator, "baz")).toBe(false);
    expect(validate(unionValidator, null)).toBe(false);
  });

  test("validates optional values", () => {
    const optionalString = v.optional(v.string());
    expect(validate(optionalString, "value")).toBe(true);
    expect(validate(optionalString, undefined)).toBe(true);
    expect(validate(optionalString, null)).toBe(false);
    expect(validate(optionalString, 123)).toBe(false);
  });

  test("validates id validator", async () => {
    const idValidator = v.id("users");
    expect(validate(idValidator, "123")).toBe(true);
    expect(validate(idValidator, "any string")).toBe(true);
    expect(
      validate(v.object({ someArray: v.optional(v.array(idValidator)) }), { someArray: ["string", "other string"] }),
    ).toBe(true);
    const t = await bunvexTest();
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { tokenIdentifier: "test" });
      expect(validate(idValidator, userId, { db: ctx.db })).toBe(true);
      expect(validate(idValidator, "not an id", { db: ctx.db })).toBe(false);
      // Not in upstream's test: an id of another table, and the message with `throw`.
      const sinkId = await ctx.db.insert("kitchenSink", valid);
      expect(validate(idValidator, sinkId, { db: ctx.db })).toBe(false);
      expect(() => validate(idValidator, sinkId, { db: ctx.db, throw: true })).toThrow(
        "Validator error: Expected `Id<users>`, got `string`",
      );
    });
  });

  test("validates system table id validator", async () => {
    const scheduledIdValidator = v.id("_scheduled_functions");
    const t = await bunvexTest();
    await t.run(async (ctx) => {
      const scheduledId = await ctx.scheduler.runAfter(60_000, "validators:toDoc" as any, {});
      expect(validate(scheduledIdValidator, scheduledId, { db: ctx.db })).toBe(true);
      expect(validate(scheduledIdValidator, "not an id", { db: ctx.db })).toBe(false);
      const userId = await ctx.db.insert("users", { tokenIdentifier: "test" });
      expect(validate(scheduledIdValidator, userId, { db: ctx.db })).toBe(false);
    });
  });

  test("a system table's id goes through db.system.normalizeId, a user table's through db.normalizeId", () => {
    const calls: string[] = [];
    const db = {
      normalizeId: (table: string, id: string) => {
        calls.push(`user ${table}`);
        return id === "good" ? id : null;
      },
      system: {
        normalizeId: (table: string, id: string) => {
          calls.push(`system ${table}`);
          return id === "good" ? id : null;
        },
      },
    } as unknown as GenericDatabaseReader<any>;
    expect(validate(v.id("_storage"), "good", { db })).toBe(true);
    expect(validate(v.id("_storage"), "bad", { db })).toBe(false);
    expect(validate(v.id("users"), "good", { db })).toBe(true);
    expect(validate(v.id("users"), 1, { db })).toBe(false); // not a string: the database is not asked
    expect(calls).toEqual(["system _storage", "system _storage", "user users"]);
    expect(() => validate(v.id("_storage"), "bad", { db, throw: true })).toThrow(
      "Validator error: Expected `Id<_storage>`, got `string`",
    );
    // A record's keys are checked as ids too.
    expect(validate(v.record(v.id("users"), v.number()), { good: 1 }, { db })).toBe(true);
    expect(validate(v.record(v.id("users"), v.number()), { bad: 1 }, { db })).toBe(false);
  });

  test("throws validation errors when configured", () => {
    expect(() => validate(v.string(), 123, { throw: true })).toThrow(ValidationError);
    expect(() => validate(v.object({ name: v.string() }), { name: 123 }, { throw: true })).toThrow(ValidationError);
    expect(() => validate(v.object({ name: v.string() }), { name: "valid", extra: true }, { throw: true })).toThrow(
      ValidationError,
    );
  });

  // Not in upstream's test: the exact messages and the error's fields.
  test("the ValidationError's message, name and fields", () => {
    const thrown = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as ValidationError;
      }
      return fail("Should have thrown");
    };
    const top = thrown(() => validate(v.string(), 123, { throw: true }));
    expect(top.name).toBe("ValidationError");
    expect(top).toBeInstanceOf(Error);
    expect(top.message).toBe("Validator error: Expected `string`, got `number`");
    expect([top.expected, top.got, top.path]).toEqual(["string", "number", undefined]);
    const extra = thrown(() => validate(v.object({ name: v.string() }), { name: "x", extra: true }, { throw: true }));
    expect(extra.message).toBe("Validator error for extra: Expected `nothing`, got `boolean`");
    expect(thrown(() => validate(v.int64(), 1, { throw: true })).message).toBe(
      "Validator error: Expected `bigint`, got `number`",
    );
    expect(thrown(() => validate(v.float64(), 1n, { throw: true })).message).toBe(
      "Validator error: Expected `number`, got `bigint`",
    );
    expect(thrown(() => validate(v.literal(3), 4, { throw: true })).message).toBe(
      'Validator error: Expected `3`, got `"4"`',
    );
    expect(thrown(() => validate(v.literal(3), 4, { throw: true })).expected as unknown).toBe(3);
    expect(thrown(() => validate(v.object({}), new Date(), { throw: true })).message).toBe(
      "Validator error: Expected `Date`, got `object`",
    );
    expect(thrown(() => validate(v.record(v.string(), v.number()), { a: "x" }, { throw: true })).message).toBe(
      "Validator error for a: Expected `number`, got `string`",
    );
    expect(thrown(() => validate(v.array(v.string()), ["a", 1], { throw: true })).message).toBe(
      "Validator error for [1]: Expected `string`, got `number`",
    );
  });

  test("doesn't throw when validating union with later matching member", () => {
    const unionValidator = v.union(v.literal("foo"), v.literal("bar"));
    expect(validate(unionValidator, "foo", { throw: true })).toBe(true);
    expect(validate(unionValidator, "bar", { throw: true })).toBe(true);
    expect(() => validate(unionValidator, "baz", { throw: true })).toThrow(
      'Validator error: Expected `bar`, got `"baz"`',
    );
    expect(() => validate(unionValidator, null, { throw: true })).toThrow(
      "Validator error: Expected `bar`, got `null`",
    );
  });

  test("includes path in error messages", () => {
    const complexValidator = v.object({ user: v.object({ details: v.object({ name: v.string() }) }) });
    try {
      validate(complexValidator, { user: { details: { name: 123 } } }, { throw: true });
      fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("user.details.name");
    }
  });

  test("includes path for nested objects", () => {
    const complexValidator = v.object({ user: v.object({ details: v.object({ name: v.string() }) }) });
    expect(validate(complexValidator, { user: { details: { name: "Alice" } } })).toBe(true);
    expect(validate(complexValidator, { user: { details: { name: 123 } } })).toBe(false);
    try {
      validate(complexValidator, { user: { details: { name: 123 } } }, { throw: true });
      fail("Should have thrown");
    } catch (e: any) {
      if (!(e instanceof ValidationError)) throw e;
      expect(e.message).toContain("user.details.name");
      expect(e.path).toBe("user.details.name");
      expect(e.expected).toBe("string");
      expect(e.got).toBe("number");
    }
  });

  test("includes path for nested arrays", () => {
    const complexValidator = v.object({ user: v.object({ details: v.array(v.string()) }) });
    expect(validate(complexValidator, { user: { details: ["a", "b", "c"] } })).toBe(true);
    expect(validate(complexValidator, { user: { details: [1, 2, 3] } })).toBe(false);
    try {
      validate(complexValidator, { user: { details: ["a", 3] } }, { throw: true });
      fail("Should have thrown");
    } catch (e: any) {
      if (!(e instanceof ValidationError)) throw e;
      expect(e.message).toContain("user.details[1]");
      expect(e.path).toBe("user.details[1]");
      expect(e.expected).toBe("string");
      expect(e.got).toBe("number");
    }
  });

  test("validates bytes/ArrayBuffer", () => {
    const buffer = new ArrayBuffer(8);
    expect(validate(v.bytes(), buffer)).toBe(true);
    expect(validate(v.bytes(), new Uint8Array(8))).toBe(false);
    expect(validate(v.bytes(), "binary")).toBe(false);
  });

  test("validates any", () => {
    expect(validate(v.any(), "anything")).toBe(true);
    expect(validate(v.any(), 123)).toBe(true);
    expect(validate(v.any(), null)).toBe(true);
    expect(validate(v.any(), { complex: "object" })).toBe(true);
  });

  test("parse strips unknown fields", () => {
    const validator = v.object({ name: v.string(), age: v.number() });
    const result = parse(validator, { name: "Alice", age: 30, unknown: "field" });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  test("parse strips unknown fields from unions", () => {
    const validator = v.union(v.object({ name: v.string() }), v.object({ age: v.number() }));
    const result = parse(validator, { name: "Alice", age: 30, unknown: "field" });
    expect(result).toEqual({ name: "Alice" });
  });

  test("parse strips unknown fields from arrays", () => {
    const validator = v.array(v.object({ name: v.string() }));
    const result = parse(validator, [{ name: "Alice" }, { name: "Bob", unknown: "field" }]);
    expect(result[0]).toMatchObject({ name: "Alice" });
    expect(result[1]).toMatchObject({ name: "Bob" });
    expect(result[1]).toEqual({ name: "Bob" });
  });

  test("parse strips unknown fields from records", () => {
    const validator = vv.record(v.string(), v.object({ name: v.string() }));
    const result = parse(validator, { a: { name: "Alice" }, b: { name: "Bob", unknown: "field" } });
    expect(result).toEqual({ a: { name: "Alice" }, b: { name: "Bob" } });
  });

  test("parse strips unknown fields from nested objects", () => {
    const validator = v.object({
      name: v.string(),
      age: v.number(),
      details: v.object({ name: v.string(), age: v.number() }),
      union: v.union(v.object({ name: v.string() }), v.object({ age: v.number() })),
      array: v.array(v.object({ name: v.string() })),
      record: vv.record(v.string(), v.object({ name: v.string() })),
    });
    const result = parse(validator, {
      name: "Alice",
      age: 30,
      details: { name: "Alice", age: 30 },
      union: { name: "Alice", foo: "bar" },
      array: [{ name: "Alice", foo: "bar" }],
      record: { a: { name: "Alice", foo: "bar" } },
    });
    expect(result).toEqual({
      name: "Alice",
      age: 30,
      details: { name: "Alice", age: 30 },
      union: { name: "Alice" },
      array: [{ name: "Alice" }],
      record: { a: { name: "Alice" } },
    });
  });

  test("parse strips unknown fields from optional fields", () => {
    const validator = v.optional(v.object({ name: v.optional(v.string()) }));
    const result = parse(validator, { name: "Alice", unknown: "field" });
    expect(result).toEqual({ name: "Alice" });
    const result2 = parse(validator, { name: undefined, unknown: "field" });
    expect(result2).toEqual({});
    expect(Object.keys(result2!)).toEqual([]);
    const result3 = parse(validator, undefined);
    expect(result3).toEqual(undefined);
    const result4 = parse(validator, {});
    expect(result4).toEqual({});
  });

  test("union matches first member with unknown fields", () => {
    const validator = v.union(v.object({ name: v.string() }), v.object({ name: v.string(), age: v.number() }));
    const result = parse(validator, { name: "Alice", age: 30, unknown: "field" });
    expect(result).toEqual({ name: "Alice" });
  });

  test("union matches second member if matches second strictly", () => {
    const validator = v.union(v.object({ name: v.string() }), v.object({ name: v.string(), age: v.number() }));
    const result = parse(validator, { name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  test("parse handles literal union validators", () => {
    const validator = v.union(v.literal("specific"), v.literal("other"));

    expect(parse(validator, "specific")).toBe("specific");
    expect(parse(validator, "other")).toBe("other");
    expect(() => parse(validator, "not a literal")).toThrow(ValidationError);
  });

  // Not in upstream's test: `parse` returns copies, never the value given.
  test("parse copies objects, arrays and records", () => {
    const value = { list: [{ name: "a" }], map: { k: { name: "b" } } };
    const parsed = parse(
      v.object({
        list: v.array(v.object({ name: v.string() })),
        map: v.record(v.string(), v.object({ name: v.string() })),
      }),
      value,
    );
    expect(parsed).toEqual(value);
    expect(parsed).not.toBe(value);
    expect(parsed.list).not.toBe(value.list);
    expect(parsed.list[0]).not.toBe(value.list[0]);
    expect(parsed.map.k).not.toBe(value.map.k);
  });
});

describe("nullable", () => {
  // Not in upstream's test: null is the first member (H-6), where `v.nullable` puts it last.
  test("is v.union(v.null(), x): null first", () => {
    const n = nullable(v.string());
    expect(n.kind).toBe("union");
    expect(n.members.map((m) => m.kind)).toEqual(["null", "string"]);
    expect(n.json).toEqual({ type: "union", value: [{ type: "null" }, { type: "string" }] });
    expect(v.nullable(v.string()).json).toEqual({ type: "union", value: [{ type: "string" }, { type: "null" }] });
    expect(validate(n, null)).toBe(true);
    expect(validate(n, "x")).toBe(true);
    expect(validate(n, 1)).toBe(false);
    check<Equals<Infer<typeof n>, string | null>>();
  });
});

describe("the other builders", () => {
  // Not in upstream's test.
  test("literals, brandedString, deprecated, pretend and pretendRequired", () => {
    const l = literals("a", 1, false, 2n);
    expect(l.json).toEqual({
      type: "union",
      value: [
        { type: "literal", value: "a" },
        { type: "literal", value: 1 },
        { type: "literal", value: false },
        { type: "literal", value: { $integer: "AgAAAAAAAAA=" } },
      ],
    });
    check<Equals<Infer<typeof l>, "a" | 1 | false | 2n>>();
    expect(brandedString("email").json).toEqual({ type: "string" });
    expect([deprecated.kind, deprecated.isOptional]).toEqual(["any", "optional"]);
    const p = pretend(v.array(v.string()));
    expect([p.kind as string, p.isOptional as string]).toEqual(["any", "optional"]);
    check<Equals<typeof p, ReturnType<typeof v.array<ReturnType<typeof v.string>>>>>();
    const r = pretendRequired(v.number());
    expect([r.kind as string, r.isOptional as string]).toEqual(["float64", "optional"]);
    expect(validate(r, undefined)).toBe(true);
    expect(validate(r, "x")).toBe(false);
  });

  test("systemFields and withSystemFields", async () => {
    const { systemFields, withSystemFields } = await import("../../src/validators.ts");
    const s = systemFields("users");
    expect(Object.keys(s)).toEqual(["_id", "_creationTime"]);
    expect(s._id.json).toEqual({ type: "id", tableName: "users" });
    expect(s._creationTime.json).toEqual({ type: "number" });
    const w = withSystemFields("users", { name: v.string() });
    expect(Object.keys(w)).toEqual(["name", "_id", "_creationTime"]);
    check<Equals<Infer<typeof w._id>, GenericId<"users">>>();
  });

  test("typedV: v's builders, id and doc", () => {
    expect(vv.string().kind).toBe("string");
    expect(vv.id("users").json).toEqual({ type: "id", tableName: "users" });
    expect(vv.doc("users").json).toEqual(doc(schema, "users").json);
    // @ts-expect-error a table the schema does not have
    vv.id("nope");
    // AD-23: the system tables too (convex-helpers' `typedV` takes the schema's tables only).
    expect(vv.id("_storage").json).toEqual({ type: "id", tableName: "_storage" });
    check<Equals<Infer<ReturnType<typeof vv.id<"_scheduled_functions">>>, GenericId<"_scheduled_functions">>>();
  });
});

describe("partial", () => {
  test("partial with fields", () => {
    const validator = partial({ name: v.string(), age: v.number() });
    expect(validate(v.object(validator), { name: "Alice" })).toBe(true);
    expect(validate(v.object(validator), { name: "Alice", age: 30 })).toBe(true);
    expect(validate(v.object(validator), { age: 30 })).toBe(true);
    expect(validate(v.object(validator), {})).toBe(true);
    const _manualPartial = { name: v.optional(v.string()), age: v.optional(v.number()) };
    check<Equals<typeof validator, typeof _manualPartial>>();
  });

  test("partial with object", () => {
    const validator = v.object({ name: v.string(), age: v.number() });
    const partialValidator = partial(validator);
    expect(validate(partialValidator, { name: "Alice" })).toBe(true);
    expect(validate(partialValidator, { name: "Alice", age: 30 })).toBe(true);
    expect(validate(partialValidator, { age: 30 })).toBe(true);
    expect(validate(partialValidator, {})).toBe(true);
    expect(validate(partialValidator, { name: "Alice", age: 30, unknown: "field" })).toBe(false);
    expect(partialValidator.kind).toBe("object");
    expect(partialValidator.fields.name?.isOptional).toBe("optional");
    const _manualPartial = v.object({ name: v.optional(v.string()), age: v.optional(v.number()) });
    check<Equals<(typeof partialValidator)["type"], (typeof _manualPartial)["type"]>>();
    check<Equals<(typeof partialValidator)["fields"], (typeof _manualPartial)["fields"]>>();
  });

  test("partial with union", () => {
    const validator = v.union(v.object({ name: v.string() }), v.object({ age: v.number() }));
    const partialValidator = partial(validator);
    expect(validate(partialValidator, { name: "Alice" })).toBe(true);
    expect(validate(partialValidator, { age: 30 })).toBe(true);
    expect(validate(partialValidator, {})).toBe(true);
    expect(validate(partialValidator, { name: "Alice", age: 30 })).toBe(false);

    const _manualPartial = v.union(
      v.object({ name: v.optional(v.string()) }),
      v.object({ age: v.optional(v.number()) }),
    );
    // We only check the types for now
    check<Equals<(typeof partialValidator)["type"], Infer<typeof _manualPartial>>>();
  });

  test("partial with union of unions", () => {
    const validator = v.union(
      v.object({ name: v.string(), age: v.number() }),
      v.union(
        v.object({ type: v.literal("email"), email: v.string() }),
        v.object({ type: v.literal("phone"), phone: v.string() }),
      ),
    );
    const partialValidator = partial(validator);
    expect(validate(partialValidator, { name: "Alice" })).toBe(true);
    expect(validate(partialValidator, { age: 30 })).toBe(true);
    expect(validate(partialValidator, { type: "email", email: "alice@example.com" })).toBe(true);
    expect(validate(partialValidator, { type: "phone", phone: "1234567890" })).toBe(true);
    expect(validate(partialValidator, { name: "Alice", age: 30, type: "email", email: "alice@example.com" })).toBe(
      false,
    );
    expect(validate(partialValidator, { name: "Alice", age: 30, type: "phone", phone: "1234567890" })).toBe(false);
    expect(partialValidator.kind).toBe("union");
    expect(partialValidator.members[0].kind).toBe("object");
    expect(partialValidator.members[0].fields.name?.isOptional).toBe("optional");
    expect(partialValidator.members[0].fields.age?.isOptional).toBe("optional");
    expect(partialValidator.members[1].kind).toBe("union");
    expect(partialValidator.members[1].members[0].kind).toBe("object");
    expect(partialValidator.members[1].members[0].fields.type?.isOptional).toBe("optional");
    expect(partialValidator.members[1].members[0].fields.email?.isOptional).toBe("optional");
    expect(partialValidator.members[1].members[1].kind).toBe("object");
    expect(partialValidator.members[1].members[1].fields.phone?.isOptional).toBe("optional");
  });

  test("partial with doc", () => {
    const validator = doc(schema, "kitchenSink");
    const partialValidator = partial(validator);
    expect(validate(partialValidator, { name: "Alice" })).toBe(true);
    expect(validate(partialValidator, { age: 30 })).toBe(true);
    expect(validate(partialValidator, {})).toBe(true);
    type Manual = Expand<Partial<ExampleFields>> & {
      _id?: GenericId<"kitchenSink"> | undefined;
      _creationTime?: number | undefined;
    };
    const assertType = <T>(_: T) => {};
    assertType<Manual>(partialValidator.type);
  });

  // Not in upstream's test: the branches of convex-helpers' code it does not reach.
  test("an optional object or union stays optional; other kinds and optional members are refused", () => {
    const o = partial(v.optional(v.object({ a: v.string() })));
    expect([o.kind, o.isOptional]).toEqual(["object", "optional"]);
    expect(o.fields.a.isOptional).toBe("optional");
    const u = partial(v.optional(v.union(v.object({ a: v.string() }))));
    expect([u.kind, u.isOptional]).toEqual(["union", "optional"]);
    const kept = v.optional(v.string());
    expect(partial({ a: kept }).a).toBe(kept);
    expect(() => partial(v.string() as any)).toThrow(
      new Error("partial only works with union or object Validators, or a Record<string, Validator> currently"),
    );
    expect(() => partial(v.union(v.object({}), v.string()) as any)).toThrow(
      new Error("Invalid union member type: string"),
    );
    expect(() => partial(v.union(v.optional(v.object({})) as any) as any)).toThrow(
      new Error("Union members cannot be optional"),
    );
  });
});
