import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

test("one socket subscribing twice to the same query holds one reference (B14)", async () => {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", { list: query(({ db }) => db.query("items").collect()) });
  const { server, subscriptions, stop } = createServer({ engine, functions, port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
  const got: unknown[] = [];
  ws.onmessage = (m) => got.push(JSON.parse(String(m.data)));
  await new Promise((r) => (ws.onopen = r));
  const sub = JSON.stringify({ t: "sub", path: "m:list", args: {} });
  ws.send(sub);
  ws.send(sub);
  await new Promise((r) => setTimeout(r, 50));
  expect(got).toHaveLength(2); // both requests get the current value
  expect(subscriptions.size).toBe(1);
  ws.send(JSON.stringify({ t: "unsub", path: "m:list", args: {} }));
  await new Promise((r) => setTimeout(r, 50));
  expect(subscriptions.size).toBe(0);
  ws.close();
  stop();
});

test("the HTTP API speaks Convex JSON: $integer args and results round-trip (STUDY-12)", async () => {
  const { mutation } = await import("../src/functions.ts");
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }, { n }: { n: bigint }) => {
      await db.insert("items", { n });
      return n * 2n;
    }),
    all: query(({ db }) => db.query("items").collect()),
  });
  const { server, stop } = createServer({ engine, functions, port: 0 });
  const call = async (kind: string, path: string, args: unknown) =>
    (
      await fetch(`http://127.0.0.1:${server!.port}/api/${kind}`, {
        method: "POST",
        body: JSON.stringify({ path, args }),
      })
    ).json();
  const big = { $integer: Buffer.from(new BigInt64Array([2n ** 40n]).buffer).toString("base64") };
  const r = (await call("mutation", "m:add", { n: big })) as any;
  expect(r.status).toBe("success");
  expect(r.value).toEqual({ $integer: Buffer.from(new BigInt64Array([2n ** 41n]).buffer).toString("base64") });
  const all = (await call("query", "m:all", {})) as any;
  expect(all.value[0].n).toEqual(big);
  stop();
});
