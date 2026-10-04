// `returns` validators (STUDY-65 G-A10), as Convex's `tests/returns_validation.rs` pins them: a query, a
// mutation and an action whose result misses its validator fail with ReturnsValidationError (Convex's
// `ReturnsValidator::check_output`, model/src/modules/function_validators.rs), an object with a field the
// validator does not name fails too, and matching results come back. A mutation that fails this way writes
// nothing; an action's effects before it returned stay, as in Convex (it is checked after it ran).
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("returns_validation", {
    stringOutputReturnsNumberQuery: query({ args: {}, returns: v.string(), handler: () => 5 as unknown as string }),
    stringOutputReturnsNumberMutation: mutation({
      args: {},
      returns: v.string(),
      handler: async ({ db }) => {
        await db.insert("items", { by: "mutation" });
        return 5 as unknown as string;
      },
    }),
    stringOutputReturnsNumberAction: action({
      args: {},
      returns: v.string(),
      handler: async ({ runMutation }) => {
        await runMutation("returns_validation:write" as never, {} as never);
        return 5 as unknown as string;
      },
    }),
    extraOutputFields: query({
      args: {},
      returns: v.object({ a: v.string() }),
      handler: () => ({ a: "hello", extra: true }) as unknown as { a: string },
    }),
    stringOutputQuery: query({ args: {}, returns: v.string(), handler: () => "hello" }),
    stringOutputMutation: mutation({ args: {}, returns: v.string(), handler: () => "hello" }),
    stringOutputAction: action({ args: {}, returns: v.string(), handler: async () => "hello" }),
    nothingAsNull: action({ args: {}, returns: v.null(), handler: async () => {} }),
    callsBadAction: action({
      args: {},
      handler: async ({ runAction }) => {
        try {
          await runAction("returns_validation:stringOutputReturnsNumberAction" as never, {} as never);
          return "no error";
        } catch (e) {
          return (e as Error).message;
        }
      },
    }),
    write: mutation({ args: {}, handler: async ({ db }) => db.insert("items", { by: "action" }) }),
  });
  const items = () => engine.query((db) => db.query("items").collect());
  return { fns, items };
}

const BAD = "ReturnsValidationError: Value does not match validator.\n\nValue: 5.0\nValidator: v.string()";

describe("returns validation (Convex: tests/returns_validation.rs)", () => {
  test("a query's bad output (test_query_bad_output)", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("returns_validation:stringOutputReturnsNumberQuery", {})).rejects.toThrow(BAD);
  });

  test("a mutation's bad output fails it, and its writes are gone (test_mutation_bad_output)", async () => {
    const { fns, items } = await setup();
    await expect(fns.runMutation("returns_validation:stringOutputReturnsNumberMutation", {})).rejects.toThrow(BAD);
    expect(await items()).toEqual([]);
  });

  test("an action's bad output fails it; what it did before returning stays (test_action_bad_output)", async () => {
    const { fns, items } = await setup();
    await expect(fns.runAction("returns_validation:stringOutputReturnsNumberAction", {})).rejects.toThrow(BAD);
    expect((await items()).map((i) => i.by)).toEqual(["action"]);
  });

  test("an action that calls it sees the same error", async () => {
    const { fns } = await setup();
    expect(await fns.runAction("returns_validation:callsBadAction", {})).toContain(BAD);
  });

  test("an object with a field the validator does not name (test_mutation_extra_fields)", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("returns_validation:extraOutputFields", {})).rejects.toThrow(
      "ReturnsValidationError: Object contains extra field `extra` that is not in the validator.",
    );
  });

  test("matching outputs come back (test_query_output, test_mutation_output, test_action_output)", async () => {
    const { fns } = await setup();
    expect(await fns.runQuery("returns_validation:stringOutputQuery", {})).toBe("hello");
    expect(await fns.runMutation("returns_validation:stringOutputMutation", {})).toBe("hello");
    expect(await fns.runAction("returns_validation:stringOutputAction", {})).toBe("hello");
    // `undefined` is checked as null, as in Convex: `v.null()` accepts a function that returns nothing.
    expect(await fns.runAction("returns_validation:nothingAsNull", {})).toBeUndefined();
  });
});
