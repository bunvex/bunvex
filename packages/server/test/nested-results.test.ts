// What a nested call returns (`ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`), as Convex: the result
// crosses a JSON boundary (`registration_impl.ts` `runUdf` and `actions_impl.ts` return
// `jsonToConvex(result)` of the callee's `convexToJson(result === undefined ? null : result)`). So the caller
// gets `null` for `undefined`, a copy (changing it changes nothing in the callee), no `undefined` fields, and
// object fields in sorted order, as the backend stores values. bunvex handed over the callee's own value.
import { describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { action, Functions, internalMutation, internalQuery, mutation } from "../src/functions.ts";

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
