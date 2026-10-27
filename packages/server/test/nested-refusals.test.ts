// A nested call the callee's checks refuse (its arguments, its result) as its caller sees it, as Convex: a plain
// `Error` of the caller's, from the refusal's `JsError` — a query or mutation gets its message (`runUdf`,
// `InvalidArgs`), an action its display, one newline more (`performAsyncSyscall`) — so left uncaught it reads
// `Uncaught Error: …` with the caller's frame. bunvex handed over the callee's own error: one newline too many in
// a mutation, and uncaught the bare refusal with no frame (packages/differential test/nested-arg-errors.test.ts).
import { expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { describeUncaught } from "../src/errors.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";

const CHECK = 'Value does not match validator.\nPath: .n\nValue: "x"\nValidator: v.float64()';
const RETURNS = 'Value does not match validator.\n\nValue: "x"\nValidator: v.float64()';
const WIDE = { n: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, i])) };
const TOO_WIDE = "Object has too many fields (1025 > maximum number 1024)";

type Caught = { name: string; message: string; isError: boolean };
type Ctx = { runQuery: Function; runMutation: Function; runAction?: Function };
const calls = (ctx: Ctx, wide: boolean) =>
  [
    () => ctx.runQuery("m:q", { n: "x" }),
    () => ctx.runMutation("m:m", { n: "x" }),
    () => ctx.runQuery("m:r", {}),
    ...(ctx.runAction
      ? [() => ctx.runAction?.("m:a", { n: "x" }), ...(wide ? [() => ctx.runAction?.("m:a", WIDE)] : [])]
      : []),
  ] as (() => Promise<unknown>)[];
async function caught(ctx: Ctx, wide: boolean): Promise<Caught[]> {
  const out: Caught[] = [];
  for (const call of calls(ctx, wide))
    try {
      await call();
    } catch (e) {
      out.push({ name: (e as Error).name, message: (e as Error).message, isError: e instanceof Error });
    }
  return out;
}

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const fns = new Functions(engine).register("m", {
    q: query({ args: { n: v.number() }, handler: async () => null }),
    m: mutation({ args: { n: v.number() }, handler: async () => null }),
    a: action({ args: { n: v.number() }, handler: async () => null }),
    r: query({ args: {}, returns: v.number(), handler: async () => "x" as never }),
    mutationCaught: mutation(async (ctx) => caught(ctx as never, false)),
    actionCaught: action(async (ctx) => caught(ctx as never, true)),
    mutationUncaught: mutation(async (ctx) => {
      await ctx.runQuery("m:q" as never, { n: "x" } as never);
    }),
    actionUncaught: action(async (ctx) => {
      await ctx.runQuery("m:q" as never, { n: "x" } as never);
    }),
  });
  return { engine, fns };
}

test("a mutation catches a plain Error with the refusal's message: one newline less than the client's", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runMutation("m:mutationCaught", {})).toEqual([
    { name: "Error", message: `ArgumentValidationError: ${CHECK}\n`, isError: true },
    { name: "Error", message: `ArgumentValidationError: ${CHECK}\n`, isError: true },
    { name: "Error", message: `ReturnsValidationError: ${RETURNS}`, isError: true },
  ]);
  // From the client, the refusal's display, as before.
  const direct = await fns.runQuery("m:q", { n: "x" }).catch((e) => describeUncaught(e).message);
  expect(direct).toBe(`ArgumentValidationError: ${CHECK}\n\n`);
  await engine.close();
});

test("an action catches a plain Error with the refusal's display, arguments that do not decode too", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runAction("m:actionCaught", {})).toEqual([
    { name: "Error", message: `ArgumentValidationError: ${CHECK}\n\n`, isError: true },
    { name: "Error", message: `ArgumentValidationError: ${CHECK}\n\n`, isError: true },
    { name: "Error", message: `ReturnsValidationError: ${RETURNS}\n`, isError: true },
    { name: "Error", message: `ArgumentValidationError: ${CHECK}\n\n`, isError: true },
    { name: "Error", message: `Invalid arguments for m.js:a: ${TOO_WIDE}\n`, isError: true },
  ]);
  await engine.close();
});

test("left uncaught, the caller's `Uncaught Error:` and its frame", async () => {
  const { engine, fns } = await setup();
  const m = await fns.runMutation("m:mutationUncaught", {}).catch((e) => describeUncaught(e).message);
  expect(m).toStartWith(`Uncaught Error: ArgumentValidationError: ${CHECK}\n\n    at `);
  const a = await fns.runAction("m:actionUncaught", {}).catch((e) => describeUncaught(e).message);
  // (An action registered here, not pushed, has no frame of an app's: the differential test has it.)
  expect(a).toStartWith(`Uncaught Error: ArgumentValidationError: ${CHECK}\n\n\n`);
  await engine.close();
});
