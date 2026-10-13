// Values logged by pushed code, which runs in its own vm context (STUDY-35): its objects come from that context's
// realm, the documents `ctx.db` returns from the server's, and a log line renders both as Convex's console does
// (a plain object without a "null prototype" tag, a class instance by its name), however they are nested.
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

test("objects logged by pushed code: no null-prototype tag, from either realm, nested either way", async () => {
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
  await s.deployCode([
    {
      path: "logs.js",
      source: `import { mutation } from ${JSON.stringify(SERVER)};
class Point { constructor() { this.x = 1; } }
export const run = mutation(async ({ db }) => {
  await db.insert("items", { n: 1 });
  const doc = await db.query("items").first();
  console.log({ a: 1 });
  console.log("x", [1, { b: 2 }], 2);
  console.log(new Point());
  console.log(Object.create(null));
  console.log({ doc }, [doc]);
  console.log({ inner: Object.assign(Object.create(null), { c: 3 }) });
});`,
      environment: "isolate",
    },
  ]);
  const r = (await (
    await fetch(`http://127.0.0.1:${s.server.port}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "logs:run", args: {}, format: "json" }),
    })
  ).json()) as { status: string; logLines: string[] };
  expect(r).toMatchObject({ status: "success" });
  const [{ _id: id, _creationTime: t }] = await engine.query((db) => db.query("items").collect());
  expect(r.logLines).toEqual([
    "[LOG] {\n  a: 1\n}",
    "[LOG] 'x' [\n  1,\n  {\n    b: 2\n  }\n] 2",
    "[LOG] Point {\n  x: 1\n}",
    "[LOG] [Object: null prototype] {}",
    `[LOG] {\n  doc: {\n    _creationTime: ${t},\n    _id: '${id}',\n    n: 1\n  }\n} [\n  {\n    _creationTime: ${t},\n    _id: '${id}',\n    n: 1\n  }\n]`,
    "[LOG] {\n  inner: [Object: null prototype] {\n    c: 3\n  }\n}",
  ]);
});
