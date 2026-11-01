// HTTP actions under `process` (STUDY-168 PR 6): what a child may not send for one. Each forgery is the real child's,
// with one message changed as a compromised child would send it (`fixtures/children/forge.ts`): the host kills the
// child, the request fails as an internal error, nothing is written, and the next request gets a new child.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { ProcessExecutor } from "../src/executor.ts";

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const MODULES = [
  {
    path: "m.js",
    source: `
import { action, mutation, query } from ${SERVER};
export const who = action(async (ctx) => ctx.auth.getUserIdentity());
export const ins = mutation(async (ctx) => ctx.db.insert("items", { k: 1 }));
export const items = query(async (ctx) => (await ctx.db.query("items").collect()).length);
`,
    environment: "isolate" as const,
  },
  {
    path: "http.js",
    source: `
import { httpRouter, httpActionGeneric as httpAction } from ${SERVER};
const http = httpRouter();
http.route({ path: "/who", method: "GET", handler: httpAction(async (ctx) => { const who = await ctx.auth.getUserIdentity(); await ctx.runMutation("m:ins", {}); return Response.json(who); }) });
http.route({ path: "/ok", method: "GET", handler: httpAction(async () => new Response("ok")) });
export default http;
`,
    environment: "isolate" as const,
  },
];

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function deployment(mode: string) {
  provideProcessExecutor(
    () => new ProcessExecutor({ entry: join(import.meta.dir, `fixtures/children/forge-${mode}.ts`) }),
  );
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    functionSandbox: "process",
    functionSandboxIsolation: "none",
  });
  stops.push(() => s.shutdown());
  await s.codeReady;
  await s.deployCode(MODULES);
  const api = async (kind: string, path: string) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: {} }),
      })
    ).json()) as Record<string, unknown>;
  const site = (path: string) => fetch(`http://127.0.0.1:${s.site!.port}${path}`);
  return { api, site };
}

describe("a child that forges an HTTP action's messages is killed", () => {
  for (const mode of ["markNoStream", "responseNotBytes"])
    test(mode, async () => {
      const d = await deployment(mode);
      const r = await d.site("/who");
      // A system error: Convex's internal 500, as under vm (STUDY-31 §12, STUDY-171 §14's Q-PR6-3).
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({
        code: "InternalServerError",
        message: "Your request couldn't be completed. Try again later.",
      });
      expect(await d.api("query", "m:items")).toMatchObject({ status: "success", value: 0 });
      // The next request gets a new child (the forgery is in `ctx.auth`, which this one does not call).
      expect(await (await d.site("/ok")).text()).toBe("ok");
    });

  for (const mode of ["responseForAction", "formDataInAction"])
    test(`${mode}: an action may not send what only an HTTP action sends`, async () => {
      const d = await deployment(mode);
      expect(await d.api("action", "m:who")).toEqual({
        code: "InternalServerError",
        message: "Your request couldn't be completed. Try again later.",
      });
      expect(await (await d.site("/ok")).text()).toBe("ok");
    });
});
