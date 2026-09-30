import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";

async function setup() {
  const engine = await new Engine(
    defineSchema({ users: defineTable(v.any()), posts: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    greet: query({
      args: { name: v.string(), times: v.optional(v.number()) },
      returns: v.string(),
      handler: (_ctx, { name, times }) => `hi ${name}`.repeat(times ?? 1),
    }),
    wrongReturn: query({ args: {}, returns: v.number(), handler: () => "not a number" }),
    addUser: mutation({
      args: v.object({ name: v.string() }),
      handler: ({ db }, { name }) => db.insert("users", { name }),
    }),
    getUser: query({ args: { id: v.id("users") }, handler: ({ db }, { id }) => db.get("users", id) }),
    loose: query((_ctx, args: { anything?: number }) => args.anything ?? null),
    secret: internalQuery({ args: {}, handler: () => "internal" }),
    bump: internalMutation(() => 1),
    viaAction: action({ args: {}, handler: (ctx) => ctx.runQuery("m:secret", {}) }),
  });
  return { engine, fns };
}

describe("functions with args / returns validators (STUDY-13)", () => {
  test("valid calls run; the handler gets the validated args", async () => {
    const { fns } = await setup();
    expect(await fns.runQuery("m:greet", { name: "ada", times: 2 })).toBe("hi adahi ada");
    expect(await fns.runQuery("m:greet", { name: "ada" })).toBe("hi ada");
  });

  test("invalid args fail with ArgumentValidationError and Convex's message shape", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("m:greet", { name: 1 })).rejects.toThrow(
      "ArgumentValidationError: Value does not match validator.\nPath: .name\nValue: 1.0\nValidator: v.string()",
    );
    await expect(fns.runQuery("m:greet", {})).rejects.toThrow(
      "ArgumentValidationError: Object is missing the required field `name`.",
    );
    await expect(fns.runQuery("m:greet", { name: "a", extra: true })).rejects.toThrow(
      "ArgumentValidationError: Object contains extra field `extra` that is not in the validator.",
    );
    await expect(fns.runQuery("m:greet", [1] as never)).rejects.toThrow(
      "ArgumentValidationError: Arguments must be an object",
    );
  });

  test("a wrong return value fails with ReturnsValidationError", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("m:wrongReturn", {})).rejects.toThrow(
      'ReturnsValidationError: Value does not match validator.\n\nValue: "not a number"\nValidator: v.float64()',
    );
  });

  test("v.id args are checked against the real catalog", async () => {
    const { engine, fns } = await setup();
    const id = (await fns.runMutation("m:addUser", { name: "ada" })) as string;
    expect(await fns.runQuery("m:getUser", { id })).toMatchObject({ name: "ada" });
    const post = await engine.mutation((db) => db.insert("posts", {}));
    await expect(fns.runQuery("m:getUser", { id: post })).rejects.toThrow(
      'which does not match the table name in validator `v.id("users")`',
    );
  });

  test("functions without args accept any object; internal ones are not callable from clients", async () => {
    const { fns } = await setup();
    expect(await fns.runQuery("m:loose", { anything: 3 })).toBe(3);
    await expect(fns.runQuery("m:secret", {})).rejects.toThrow("function not found: m:secret");
    await expect(fns.runMutation("m:bump", {})).rejects.toThrow("function not found: m:bump");
    expect(await fns.runAction("m:viaAction", {})).toBe("internal"); // actions may call internal functions
  });

  test("handler args are typed from the validators (checked by tsc)", () => {
    query({
      args: { n: v.int64(), tag: v.optional(v.literal("x")) },
      handler: (_ctx, args) => {
        const n: bigint = args.n;
        const tag: "x" | undefined = args.tag;
        // @ts-expect-error — `n` is a bigint, not a string
        const s: string = args.n;
        return [n, tag, s];
      },
    });
    expect(true).toBe(true);
  });
});
