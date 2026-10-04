// An HTTP action whose client goes away (STUDY-65 G-A11, M4), as Convex's `tests/http_action.rs`
// `test_http_action_continues_after_client_disconnects` and `test_http_action_disconnect_before_head`: the
// handler runs to the end and what it wrote is committed; when the client left before the response head
// could be sent, the execution is logged as failed with "Client disconnected" (Convex fails to write the head).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import type { Part } from "../src/function-log.ts";
import { Functions, internalMutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const functions = new Functions(engine).register("functions", {
    write: internalMutation(async ({ db }) => {
      await db.insert("items", { wrote: true });
    }),
    didWrite: query(async ({ db }) => (await db.query("items").collect()).length > 0),
  });
  const http = httpRouter();
  http.route({
    path: "/writeAfterDisconnect",
    method: "GET",
    handler: httpAction(async (ctx) => {
      entered();
      await gate;
      await ctx.runMutation("functions:write" as never, {} as never);
      finished();
      return new Response("written");
    }),
  });
  const server = createServer({ engine, functions, port: 0, http, redactLogsToClient: false });
  stops.push(server.stop);
  const site = `http://127.0.0.1:${server.site!.port}`;
  const completions = async () =>
    ((await functions.functionLog!.after(0, 0)).parts as Part[]).filter(
      (p) => p.kind === "Completion" && p.udfType === "HttpAction",
    ) as Record<string, any>[];
  return { site, functions, inside, open: () => open(), done, completions };
}

test("the action runs to the end after its client went away, its write committed; logged as Client disconnected", async () => {
  const { site, functions, inside, open, done, completions } = await setup();
  const client = new AbortController();
  const request = fetch(`${site}/writeAfterDisconnect`, { signal: client.signal }).catch(() => "aborted");
  await inside;
  client.abort();
  expect(await request).toBe("aborted");
  // Let Bun notice the closed socket, then let the handler go on.
  await Bun.sleep(50);
  open();
  await done;
  expect(await functions.runQuery("functions:didWrite", {})).toBe(true);
  let logged: Record<string, any>[] = [];
  for (let i = 0; i < 100 && logged.length === 0; i++) {
    logged = await completions();
    if (logged.length === 0) await Bun.sleep(10);
  }
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ identifier: "GET /writeAfterDisconnect" });
  expect(logged[0]).toMatchObject({ error: "Client disconnected", success: null });
});
