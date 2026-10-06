// What a nested call returns (`ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`), as Convex: the result
// crosses a JSON boundary (`registration_impl.ts` `runUdf` and `actions_impl.ts` return
// `jsonToConvex(result)` of the callee's `convexToJson(result === undefined ? null : result)`). So the caller
// gets `null` for `undefined`, a copy (changing it changes nothing in the callee), no `undefined` fields, and
// object fields in sorted order, as the backend stores values. bunvex handed over the callee's own value.
import { describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { action, Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";

const shared = { n: 1, nested: { list: [1, 2] } };

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const fns = new Functions(engine).register("m", {
    nothingQ: internalQuery(async () => {}),
    nothingM: internalMutation(async () => {}),
    nothingA: action(async () => {}),
    sharedQ: internalQuery(async () => shared),
    shapeQ: internalQuery(async () => ({ z: 1, a: undefined, m: { y: 2, b: 3 } })),
    dateQ: internalQuery(async () => ({ when: new Date(0) })),
    callsDate: mutation(async ({ runQuery }) => {
      try {
        await runQuery("m:dateQ" as never, {} as never);
        return "no error";
      } catch (e) {
        return (e as Error).message;
      }
    }),
    fromMutation: mutation(async ({ runQuery }) => {
      const nothing = await runQuery("m:nothingQ" as never, {} as never);
      const mine = (await runQuery("m:sharedQ" as never, {} as never)) as typeof shared;
      mine.n = 99;
      mine.nested.list.push(3);
      const shape = (await runQuery("m:shapeQ" as never, {} as never)) as Record<string, unknown>;
      return { nothing, shared: { ...shared }, keys: Object.keys(shape), inner: Object.keys(shape.m as object) };
    }),
    fromAction: action(async ({ runQuery, runMutation, runAction }) => {
      const q = await runQuery("m:nothingQ" as never, {} as never);
      const m = await runMutation("m:nothingM" as never, {} as never);
      const a = await runAction("m:nothingA" as never, {} as never);
      const mine = (await runQuery("m:sharedQ" as never, {} as never)) as typeof shared;
      mine.n = 42;
      return { q, m, a, n: shared.n };
    }),
  });
  return { fns };
}

describe("nested results cross a JSON boundary, as Convex", () => {
  test("from a mutation: null for undefined; a copy; no undefined fields; fields sorted", async () => {
    const { fns } = await setup();
    const r = (await fns.runMutation("m:fromMutation", {})) as Record<string, unknown>;
    expect(r.nothing).toBeNull();
    expect(r.shared).toEqual({ n: 1, nested: { list: [1, 2] } });
    expect(r.keys).toEqual(["m", "z"]);
    expect(r.inner).toEqual(["b", "y"]);
  });

  test("a result that is not a value fails, as Convex's serialization of it does", async () => {
    const { fns } = await setup();
    expect(await fns.runMutation("m:callsDate", {})).toContain("is not a supported");
  });

  test("from an action: runQuery, runMutation and runAction give null for undefined, and copies", async () => {
    const { fns } = await setup();
    expect(await fns.runAction("m:fromAction", {})).toEqual({ q: null, m: null, a: null, n: 1 });
  });
});

// A nested call's arguments cross the same boundary (Convex's `runUdf` and `actions_impl.ts` send
// `convexToJson(args)`, which Rust parses into a `ConvexValue`, its objects sorted, before the callee gets them):
// the callee sees their fields sorted. A top-level call's arguments keep their order. Found by the differential
// tests (STUDY-122 phase 3), through a `BunvexError` whose data came from its arguments.
describe("nested arguments cross a JSON boundary, as Convex", () => {
  async function argsSetup() {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const keysOf = (o: { o: Record<string, unknown> }) => ({
      top: Object.keys(o.o),
      inner: Object.keys(o.o.inner as object),
    });
    const fns = new Functions(engine).register("m", {
      keysQ: internalQuery(async (_ctx, a: { o: Record<string, unknown> }) => keysOf(a)),
      keysPublic: query(async (_ctx, a: { o: Record<string, unknown> }) => keysOf(a)),
      keysM: internalMutation(async (_ctx, a: { o: Record<string, unknown> }) => keysOf(a)),
      keysA: action(async (_ctx, a: { o: Record<string, unknown> }) => keysOf(a)),
      changesArgs: internalMutation(async (_ctx, a: { o: Record<string, unknown> }) => {
        a.o.x = 99;
        return null;
      }),
      keepsItsArgs: mutation(async ({ runMutation }) => {
        const mine = { o: { x: 1 } };
        await runMutation("m:changesArgs" as never, mine as never);
        return mine.o.x;
      }),
      fromMutation: mutation(async ({ runQuery, runMutation }) => ({
        q: await runQuery("m:keysQ" as never, { o: { y: 1, x: 2, inner: { b: 1, a: 2 } } } as never),
        m: await runMutation("m:keysM" as never, { o: { y: 1, x: 2, inner: { b: 1, a: 2 } } } as never),
      })),
      fromAction: action(async ({ runQuery, runMutation, runAction }) => ({
        q: await runQuery("m:keysQ" as never, { o: { y: 1, x: 2, inner: { b: 1, a: 2 } } } as never),
        m: await runMutation("m:keysM" as never, { o: { y: 1, x: 2, inner: { b: 1, a: 2 } } } as never),
        a: await runAction("m:keysA" as never, { o: { y: 1, x: 2, inner: { b: 1, a: 2 } } } as never),
      })),
    });
    return { fns };
  }
  const sorted = { top: ["inner", "x", "y"], inner: ["a", "b"] };

  test("from a mutation and from an action: the callee's arguments have their fields sorted", async () => {
    const { fns } = await argsSetup();
    expect(await fns.runMutation("m:fromMutation", {})).toEqual({ q: sorted, m: sorted });
    expect(await fns.runAction("m:fromAction", {})).toEqual({ q: sorted, m: sorted, a: sorted });
  });

  test("the callee gets a copy: changing its arguments changes nothing of the caller's", async () => {
    const { fns } = await argsSetup();
    expect(await fns.runMutation("m:keepsItsArgs", {})).toBe(1);
  });

  test("a top-level call's arguments keep their order", async () => {
    const { fns } = await argsSetup();
    expect(await fns.runQuery("m:keysPublic", { o: { y: 1, x: 2, inner: { b: 1, a: 2 } } })).toEqual({
      top: ["y", "x", "inner"],
      inner: ["b", "a"],
    });
  });
});
