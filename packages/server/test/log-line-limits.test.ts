// Log line limits by kind, as Convex's since `04e9983` + `0e4f90d` (STUDY-186 A1): 256 lines for a query or
// mutation (`MAX_LOG_LINES_DATABASE_UDFS`), 1024 for a V8 or HTTP action (`MAX_LOG_LINES_V8_ACTIONS`) and for a
// "use node" action (`MAX_LOG_LINES_NODE_ACTIONS`), the last of them the overflow notice. An action's streamed lines
// (its Progress events) stop at the same limit, as Convex's action environment stops sending them.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { FunctionLog } from "../src/function-log.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { prettyLogLine } from "../src/logs.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const SERVER = ["bunvex", "server"].join("/");
const overflow = (n: number) => `[ERROR] Log overflow (maximum ${n}). Remaining log lines omitted.`;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const logs = (n: number) => {
  for (let i = 0; i < n; i++) console.log(i);
  return null;
};

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    q: query((_ctx, { n }: { n: number }) => logs(n)),
    m: mutation((_ctx, { n }: { n: number }) => logs(n)),
    a: action((_ctx, { n }: { n: number }) => logs(n)),
  });
  const http = httpRouter();
  http.route({ path: "/log", method: "GET", handler: httpAction(async () => new Response(String(logs(1100)))) });
  const s = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: false,
    http,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
  });
  stops.push(() => s.shutdown());
  // After the server's own, a log with room for every streamed line (the server's keeps 1000, `MAX_UDF_EXECUTION`).
  const log = new FunctionLog(10_000);
  functions.functionLog = log;
  const api = `http://127.0.0.1:${s.server!.port}`;
  const call = async (kind: string, path: string, args: object) =>
    (await (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()) as { status: string; logLines: string[] };
  /** The lines the action streamed (its Progress events), as clients print them. */
  const streamed = async () =>
    (await log.after(0, 0)).parts.flatMap((p) => (p.kind === "Progress" ? p.logLines.map(prettyLogLine) : []));
  return { s, call, streamed, site: `http://127.0.0.1:${s.site!.port}` };
}

test("a query and a mutation: 256 lines, the last the overflow notice", async () => {
  const { call } = await setup();
  for (const kind of ["query", "mutation"]) {
    const lines = (await call(kind, `m:${kind[0]}`, { n: 300 })).logLines;
    expect({ kind, n: lines.length, last: lines.at(-1), before: lines.at(-2) }).toEqual({
      kind,
      n: 256,
      last: overflow(256),
      before: "[LOG] 254",
    });
    expect((await call(kind, `m:${kind[0]}`, { n: 255 })).logLines).toHaveLength(255);
  }
});

test("an action: 1024 lines, the last the overflow notice; its stream stops there too", async () => {
  const { call, streamed } = await setup();
  const lines = (await call("action", "m:a", { n: 1100 })).logLines;
  expect({ n: lines.length, last: lines.at(-1), before: lines.at(-2) }).toEqual({
    n: 1024,
    last: overflow(1024),
    before: "[LOG] 1022",
  });
  const out = await streamed();
  expect({ n: out.length, last: out.at(-1) }).toEqual({ n: 1024, last: overflow(1024) });
  expect((await call("action", "m:a", { n: 1023 })).logLines).toHaveLength(1023);
  expect((await call("action", "m:a", { n: 1023 })).logLines.at(-1)).toBe("[LOG] 1022");
});

test("an HTTP action: 1024 lines in its log, the last the overflow notice", async () => {
  const { site, streamed } = await setup();
  expect(await (await fetch(`${site}/log`)).text()).toBe("null");
  const out = await streamed();
  expect({ n: out.length, last: out.at(-1) }).toEqual({ n: 1024, last: overflow(1024) });
});

test('a "use node" action: 1024 lines, the last the overflow notice', async () => {
  const { s, call } = await setup();
  await s.deployCode([
    {
      path: "n.js",
      environment: "node",
      source: `"use node";
import { action } from ${JSON.stringify(SERVER)};
export const a = action(async () => {
  for (let i = 0; i < 1100; i++) console.log(i);
  return null;
});`,
    },
  ]);
  const lines = (await call("action", "n:a", {})).logLines;
  expect({ n: lines.length, last: lines.at(-1), before: lines.at(-2) }).toEqual({
    n: 1024,
    last: overflow(1024),
    before: "[LOG] 1022",
  });
});
