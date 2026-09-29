import { expect, test } from "bun:test";
import { Engine, Schema } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

test("one socket subscribing twice to the same query holds one reference (B14)", async () => {
  const engine = await new Engine(
    new Schema().table("items", {}),
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
