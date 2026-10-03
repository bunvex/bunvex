// The HTTP API (STUDY-18): Convex JSON arguments and results.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

test("the HTTP API speaks Convex JSON: $integer args and results round-trip (STUDY-18)", async () => {
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "convex_encoded_json" }),
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
