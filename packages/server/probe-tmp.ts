import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "./src/functions.ts";
import { createServer } from "./src/server.ts";

const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
const functions = new Functions(engine).register("m", {
  any: query({
    args: { x: v.any() },
    handler: async (_, { x }) => (Array.isArray(x) ? x.length : Object.keys(x).length),
  }),
  loose: query(async (_, a: any) => (Array.isArray(a.x) ? a.x.length : Object.keys(a.x).length)),
  call: query(async (ctx: any) => {
    try {
      return await ctx.runQuery("m:loose" as any, { x: Array.from({ length: 9000 }, () => 1) });
    } catch (e) {
      return `caught: ${(e as Error).message}`;
    }
  }),
});
const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
const big = Array.from({ length: 9000 }, () => 1);
const wide = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`f${i}`, 1]));
for (const [label, path, args] of [
  ["array 9000, validated", "m:any", { x: big }],
  ["array 9000, no validator", "m:loose", { x: big }],
  ["object 1100 fields", "m:loose", { x: wide }],
  ["nested call", "m:call", {}],
] as const) {
  const r = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  console.log(label, r.status, JSON.stringify(await r.json()).slice(0, 220));
}
await stop();
