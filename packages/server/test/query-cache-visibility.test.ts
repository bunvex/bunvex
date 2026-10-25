// A query's cached result is kept per caller kind, as in Convex: `StoredCacheKey` (crates/application/src/cache/mod.rs)
// holds the caller's `allowed_visibility`, `PublicOnly` for a client (HTTP API, sync) and `All` for an action's
// `ctx.runQuery` (`FunctionCaller::allowed_visibility`, crates/common/src/types/functions.rs). So a client's call
// never reuses a result an action's call cached, nor the other way round; each reuses its own. Found by the
// differential log tail (STUDY-174 §5.2): Convex answered "miss" where bunvex answered "hit".
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable({ n: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    count: query({ args: {}, handler: async (ctx) => (await ctx.db.query("items").collect()).length }),
    viaAction: action({ args: {}, handler: async (ctx): Promise<number> => ctx.runQuery("m:count" as never, {}) }),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server!.port}`;
  const call = async (route: string, path: string) => {
    const r = await fetch(`${api}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {}, format: "json" }),
    });
    expect(((await r.json()) as { status: string }).status).toBe("success");
  };
  let cursor = 0;
  /** `hit` or `miss` for each query completion logged since the last call. */
  const queries = async (want: number) => {
    const seen: string[] = [];
    for (let i = 0; i < 100 && seen.length < want; i++) {
      const r = await fetch(`${api}/api/stream_function_logs?cursor=${cursor}`, {
        headers: { authorization: `Bunvex ${KEY}` },
      });
      const body = (await r.json()) as {
        entries: { kind: string; udfType?: string; cachedResult?: boolean }[];
        newCursor: number;
      };
      for (const e of body.entries)
        if (e.kind === "Completion" && e.udfType === "Query") seen.push(e.cachedResult ? "hit" : "miss");
      cursor = body.newCursor;
      if (seen.length < want) await Bun.sleep(20);
    }
    return seen;
  };
  return { call, queries };
}

test("a client's query does not reuse what an action's runQuery cached, nor the other way round", async () => {
  const { call, queries } = await setup();
  await call("action", "m:viaAction");
  await call("query", "m:count");
  expect(await queries(2)).toEqual(["miss", "miss"]);

  await call("query", "m:count");
  await call("action", "m:viaAction");
  expect(await queries(2)).toEqual(["hit", "hit"]);
});
