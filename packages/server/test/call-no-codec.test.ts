// STUDY-194 Q7 (owner, 2026-10-27): outside the tests a call crosses the boundary without the codec. The engine's
// `callCodec: false` is that server: the arguments reach the handler as the caller passed them, and queries,
// mutations and session mutations behave as through the codec.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable({ n: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
    { callCodec: false },
  ).init();
  let seen: unknown;
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }, a: { n: number }) => {
      seen = a;
      return db.insert("items", { n: a.n });
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    typed: query({ args: { n: v.number() }, handler: (_ctx, { n }) => n }),
  });
  return { engine, functions, seen: () => seen };
}

test("without the codec: the handler gets the caller's own arguments; reads, writes and the cache as with it", async () => {
  const t = await setup();
  expect(t.engine.callCodec).toBe(false);
  const args = { n: 1, extra: undefined };
  await t.functions.runMutation("m:add", args);
  expect(t.seen()).toBe(args);
  expect(await t.functions.runQueryJson("m:count", {})).toBe("1");
  await t.functions.runMutation("m:add", { n: 2 });
  expect(await t.functions.runQueryJson("m:count", {})).toBe("2");
  expect(await t.functions.runQuery("m:typed", { n: 3 })).toBe(3);
  await expect(t.functions.runQuery("m:typed", { n: "x" })).rejects.toThrow("ArgumentValidationError");
  const first = await t.functions.runSessionMutation("m:add", { n: 4 }, { sessionId: "s", requestId: 1 });
  const again = await t.functions.runSessionMutation("m:add", { n: 4 }, { sessionId: "s", requestId: 1 });
  expect("value" in first && "replayed" in again).toBe(true);
  expect(await t.functions.runQueryJson("m:count", {})).toBe("3");
});
