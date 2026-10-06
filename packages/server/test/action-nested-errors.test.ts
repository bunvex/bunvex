// What an action catches when a query, mutation or action it calls fails, as Convex: `actions_impl.ts` runs
// them through `performAsyncSyscall`, which rethrows `new Error(e.message)` — or, with data,
// `new ConvexError(e.message)` and the data — where `e.message` is the callee's uncaught message (its line and
// frames). bunvex handed over the callee's own error, so a message read "boom" where Convex's reads
// "Uncaught Error: boom" (found by the differential tests, STUDY-122 phase 3).
import { expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError } from "@bunvex/values";
import { action, Functions, internalAction, internalMutation, internalQuery } from "../src/functions.ts";

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const fns = new Functions(engine).register("m", {
    failQ: internalQuery(async () => {
      throw new Error("query boom");
    }),
    failM: internalMutation(async () => {
      throw new Error("mutation boom");
    }),
    failData: internalMutation(async () => {
      throw new BunvexError({ code: 7 });
    }),
    failA: internalAction(async () => {
      throw new Error("action boom");
    }),
    caller: action(async ({ runQuery, runMutation, runAction }) => {
      const out: unknown[] = [];
      for (const call of [
        () => runQuery("m:failQ" as never, {} as never),
        () => runMutation("m:failM" as never, {} as never),
        () => runMutation("m:failData" as never, {} as never),
        () => runAction("m:failA" as never, {} as never),
      ])
        try {
          await call();
        } catch (e) {
          out.push({
            message: (e as Error).message,
            data: (e as BunvexError<never>).data,
            isBunvex: e instanceof BunvexError,
          });
        }
      return out;
    }),
  });
  return { engine, fns };
}

test("an action catches its callee's uncaught message, and a BunvexError's data", async () => {
  const { engine, fns } = await setup();
  const caught = (await fns.runAction("m:caller", {})) as { message: string; data?: unknown; isBunvex: boolean }[];
  expect(caught.map((c) => c.message.split("\n")[0])).toEqual([
    "Uncaught Error: query boom",
    "Uncaught Error: mutation boom",
    'Uncaught BunvexError: {"code":7}',
    "Uncaught Error: action boom",
  ]);
  // The callee's frames follow its line, as in Convex's message.
  for (const c of caught) expect(c.message).toMatch(/\n {4}at /);
  expect(caught.map((c) => [c.isBunvex, c.data ?? null])).toEqual([
    [false, null],
    [false, null],
    [true, { code: 7 }],
    [false, null],
  ]);
  await engine.close();
});
