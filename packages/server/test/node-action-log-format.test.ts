// A "use node" action's console lines as Convex's node executor writes them (npm-packages/node-executor
// src/executor.ts `consoleMessage`): every argument through Node's `util.inspect` — the `time*` label line and
// the timer warnings too, as strings — while V8 functions keep their own format (the label line bare).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = ["bunvex", "server"].join("/");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("a node action logs through util.inspect; a query it calls keeps the V8 format", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  stops.push(() => s.shutdown());
  const body = `
  console.log("x", { a: 1, b: [1, 2] }, 2);
  console.time("foo");
  console.time("foo");
  console.timeLog("foo", "bar", { c: 3 });
  console.timeEnd("foo");
  console.timeEnd("foo");`;
  await s.deployCode([
    {
      path: "v8.js",
      environment: "isolate",
      source: `import { query } from ${JSON.stringify(SERVER)};
export const q = query(async () => {${body.replaceAll(", { a: 1, b: [1, 2] }", "").replaceAll(", { c: 3 }", "")}
  return null;
});`,
    },
    {
      path: "n.js",
      environment: "node",
      source: `"use node";
import { action } from ${JSON.stringify(SERVER)};
export const a = action(async (ctx) => {${body}
  await ctx.runQuery("v8:q", {});
  return null;
});`,
    },
  ]);
  const r = (await (
    await fetch(`http://127.0.0.1:${s.server.port}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "n:a", args: {}, format: "json" }),
    })
  ).json()) as { status: string; logLines: string[] };
  expect(r).toMatchObject({ status: "success" });
  const lines = r.logLines.map((l) => l.replace(/\d+ms/g, "Nms"));
  expect(lines).toEqual([
    "[LOG] 'x' { a: 1, b: [ 1, 2 ] } 2",
    `[WARN] "Timer 'foo' already exists"`,
    "[INFO] 'foo: Nms' 'bar' { c: 3 }",
    "[INFO] 'foo: Nms'",
    `[WARN] "Timer 'foo' does not exist"`,
    "[LOG] 'x' 2",
    "[WARN] Timer 'foo' already exists",
    "[INFO] foo: Nms 'bar'",
    "[INFO] foo: Nms",
    "[WARN] Timer 'foo' does not exist",
  ]);
});
