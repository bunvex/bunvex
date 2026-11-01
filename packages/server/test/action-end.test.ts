// An action ends with its answer, as Convex's isolate does (`crates/isolate/src/environment/action/mod.rs:1226-1233`
// at 72ce13c: the task executor is shut down once the action's result is in, and no JavaScript of the action runs
// after it; owner, 2026-10-21, STUDY-171 §12.11). Under `vm`:
// - a timer its code set and that fires while it runs works as before; one still pending when it answers (or times
//   out) is cleared, `setInterval`'s too;
// - a `ctx` call or a `fetch` made after its end (a `ctx` kept in module state, an operation's continuation) is
//   refused, with the words the function sandbox's child uses;
// - an operation started before its end goes on (it was in flight), as before.
// An HTTP action ends the same way, with its body (Convex's isolate runs until the response's stream ends): its body's
// code runs on while it streams, and once it has been handed over (or the handler failed, or the client left) its
// timers are cleared and a `ctx` it kept refuses. `"use node"` actions keep running as before.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { ACTION_ENDED_MESSAGE, trackActionTimer, trackedActionTimers } from "../src/action-timeout.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const MODULE = `
import { action, query, mutation, httpRouter, httpAction } from ${SERVER};
const state = { fired: 0, ticks: 0, saved: null, late: [] };
export const read = query(async (ctx, { i }) => [(await ctx.db.query("items").collect()).length, state.fired, state.ticks, state.late]);
export const ins = mutation(async (ctx, { k }) => ctx.db.insert("items", { k }));
export const slowIns = mutation(async (ctx, { k }) => { await ctx.db.insert("items", { k }); return k; });
export const firesWhileRunning = action(async () => { await new Promise((r) => setTimeout(r, 20)); let n = 0; await new Promise((r) => { const t = setInterval(() => { if (++n === 3) { clearInterval(t); r(); } }, 5); }); return n; });
export const leavesTimeout = action(async (ctx) => { setTimeout(async () => { state.fired++; try { await ctx.runMutation("m:ins", { k: 1 }); } catch (e) { state.late.push(e.message); } }, 50); return 1; });
export const leavesInterval = action(async () => { setInterval(() => { state.ticks++; }, 10); await new Promise((r) => setTimeout(r, 45)); return state.ticks > 0; });
export const keepsCtx = action(async (ctx) => { state.saved = ctx; return 1; });
export const usesSaved = action(async () => {
  const out = [];
  for (const call of [() => state.saved.runQuery("m:read", { i: 1 }), () => state.saved.runMutation("m:ins", { k: 2 }), () => state.saved.scheduler.runAfter(0, "m:ins", { k: 3 }), () => state.saved.auth.getUserIdentity(), () => state.saved.meta.getFunctionMetadata(), () => state.saved.storage.generateUploadUrl(), () => state.saved.vectorSearch("items", "nope", { vector: [1] })])
    try { await call(); out.push("ran"); } catch (e) { out.push(e.message); }
  return out;
});
export const continuation = action(async (ctx) => { ctx.runQuery("m:read", { i: 2 }).then(() => ctx.runMutation("m:ins", { k: 4 })).catch((e) => state.late.push(e.message)); return 1; });
export const lateTimer = action(async (ctx) => { ctx.runQuery("m:read", { i: 4 }).then(() => setTimeout(() => { state.fired++; }, 10)); return 1; });
export const inFlight = action(async (ctx) => { ctx.runMutation("m:slowIns", { k: 5 }); return 1; });
export const fetchLater = action(async (ctx, { url }) => { ctx.runQuery("m:read", { i: 3 }).then(() => fetch(url)).then(() => state.late.push("fetched"), (e) => state.late.push([e.name, e.message])); return 1; });
export const timesOut = action(async () => { setInterval(() => { state.ticks++; }, 10); await new Promise(() => {}); });
const http = httpRouter();
http.route({ path: "/stream", method: "GET", handler: httpAction(async (ctx) => {
  let n = 0;
  return new Response(new ReadableStream({ async pull(c) { if (n++ === 2) return c.close(); await new Promise((r) => setTimeout(r, 10)); c.enqueue(new TextEncoder().encode(String((await ctx.runQuery("m:read", { i: 100 + n }))[0]))); } }));
}) });
http.route({ path: "/leftTimer", method: "GET", handler: httpAction(async (ctx) => { state.saved = ctx; setTimeout(async () => { state.fired++; try { await ctx.runMutation("m:ins", { k: 10 }); } catch (e) { state.late.push(e.message); } }, 50); return new Response("answered"); }) });
http.route({ path: "/leftInterval", method: "GET", handler: httpAction(async () => { setInterval(() => { state.ticks++; }, 10); await new Promise((r) => setTimeout(r, 45)); return new Response(new Uint8Array([1, 2])); }) });
http.route({ path: "/throwsLeavingTimer", method: "GET", handler: httpAction(async () => { setTimeout(() => { state.fired++; }, 30); throw new Error("no"); }) });
http.route({ path: "/streamLeavesTimer", method: "GET", handler: httpAction(async (ctx) => {
  let n = 0;
  return new Response(new ReadableStream({ async pull(c) {
    await new Promise((r) => setTimeout(r, 10));
    if (n++ === 2) { setTimeout(() => { state.fired++; ctx.runMutation("m:ins", { k: 11 }).catch((e) => state.late.push(e.message)); }, 30); return c.close(); }
    await ctx.runMutation("m:ins", { k: 12 });
    c.enqueue(new TextEncoder().encode("x"));
  } }));
}) });
http.route({ path: "/endless", method: "GET", handler: httpAction(async () => {
  return new Response(new ReadableStream({ start() { setInterval(() => { state.ticks++; }, 10); }, async pull(c) { await new Promise((r) => setTimeout(r, 5)); c.enqueue(new Uint8Array([1])); } }));
}) });
http.route({ path: "/fetchLater", method: "POST", handler: httpAction(async (ctx, req) => { const url = await req.text(); ctx.runQuery("m:read", { i: 5 }).then(() => fetch(url)).then(() => state.late.push("fetched"), (e) => state.late.push([e.name, e.message])); return new Response("ok"); }) });
export default http;
`;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function deployment() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, deployable: true, fileStorage: null });
  stops.push(() => s.shutdown());
  await s.codeReady;
  await s.deployCode([
    { path: "m.js", source: MODULE, environment: "isolate" },
    { path: "http.js", source: `export { default } from "./m.js";`, environment: "isolate" },
  ]);
  let i = 0;
  const read = async () =>
    (await functions.runQuery("m:read", { i: ++i * 1000 })) as [number, number, number, unknown[]];
  return { s, functions, read };
}

describe("a V8 action ends with its answer", () => {
  test("a timer that fires while it runs works, setInterval's too", async () => {
    const d = await deployment();
    expect(await d.functions.runAction("m:firesWhileRunning", {})).toBe(3);
  });

  test("a timer still pending when it answers never fires", async () => {
    const d = await deployment();
    expect(await d.functions.runAction("m:leavesTimeout", {})).toBe(1);
    await Bun.sleep(150);
    expect(await d.read()).toEqual([0, 0, 0, []]);
  });

  test("an interval stops when it answers", async () => {
    const d = await deployment();
    expect(await d.functions.runAction("m:leavesInterval", {})).toBe(true);
    const [, , ticks] = await d.read();
    await Bun.sleep(100);
    expect((await d.read())[2]).toBe(ticks);
  });

  test("an interval stops when it times out", async () => {
    const d = await deployment();
    d.functions.actionTimeoutMs = 60;
    await expect(d.functions.runAction("m:timesOut", {})).rejects.toThrow("Function execution timed out");
    const [, , ticks] = await d.read();
    expect(ticks).toBeGreaterThan(0);
    await Bun.sleep(100);
    expect((await d.read())[2]).toBe(ticks);
  });

  test("its ctx, kept and called after its end, refuses every call with the sandbox's words", async () => {
    const d = await deployment();
    await d.functions.runAction("m:keepsCtx", {});
    expect(await d.functions.runAction("m:usesSaved", {})).toEqual(Array(7).fill(ACTION_ENDED_MESSAGE));
    expect((await d.read())[0]).toBe(0);
  });

  test("an operation's continuation after its end is refused; the operation itself went on", async () => {
    const d = await deployment();
    await d.functions.runAction("m:continuation", {});
    await Bun.sleep(100);
    expect(await d.read()).toEqual([0, 0, 0, [ACTION_ENDED_MESSAGE]]);
  });

  test("a timer set after its end (in an operation's continuation) is cleared at once", async () => {
    const d = await deployment();
    await d.functions.runAction("m:lateTimer", {});
    await Bun.sleep(100);
    expect((await d.read())[1]).toBe(0);
  });

  test("an operation in flight when it answers goes on", async () => {
    const d = await deployment();
    await d.functions.runAction("m:inFlight", {});
    await Bun.sleep(100);
    expect((await d.read())[0]).toBe(1);
  });

  test("a fetch made after its end (an operation's continuation) is refused, with the same words", async () => {
    const d = await deployment();
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    stops.push(() => target.stop(true));
    await d.functions.runAction("m:fetchLater", { url: `http://127.0.0.1:${target.port}/` });
    await Bun.sleep(100);
    expect((await d.read())[3]).toEqual([["Error", ACTION_ENDED_MESSAGE]]);
  });
});

describe("an HTTP action ends with its body", () => {
  const get = (d: Awaited<ReturnType<typeof deployment>>, path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${d.s.server.port}/http${path}`, init);

  test("its body still streams after its handler returned, calling ctx and its timers", async () => {
    const d = await deployment();
    expect(await (await get(d, "/stream")).text()).toBe("00");
  });

  test("a timer its handler left never fires; a ctx it kept refuses with the sandbox's words", async () => {
    const d = await deployment();
    expect(await (await get(d, "/leftTimer")).text()).toBe("answered");
    await Bun.sleep(150);
    expect(await d.read()).toEqual([0, 0, 0, []]);
    expect(await d.functions.runAction("m:usesSaved", {})).toEqual(Array(7).fill(ACTION_ENDED_MESSAGE));
    expect((await d.read())[0]).toBe(0);
  });

  test("an interval it left stops with its body", async () => {
    const d = await deployment();
    expect([...new Uint8Array(await (await get(d, "/leftInterval")).arrayBuffer())]).toEqual([1, 2]);
    const [, , ticks] = await d.read();
    expect(ticks).toBeGreaterThan(0);
    await Bun.sleep(100);
    expect((await d.read())[2]).toBe(ticks);
  });

  test("a handler that throws ends it: the timer it left never fires", async () => {
    const d = await deployment();
    expect((await get(d, "/throwsLeavingTimer")).status).toBe(500);
    await Bun.sleep(100);
    expect((await d.read())[1]).toBe(0);
  });

  test("a timer its streamed body left when it ended never fires; what it wrote while streaming stays", async () => {
    const d = await deployment();
    expect(await (await get(d, "/streamLeavesTimer")).text()).toBe("xx");
    await Bun.sleep(150);
    expect(await d.read()).toEqual([2, 0, 0, []]);
  });

  test("a client that leaves mid-body ends it: its body's interval stops", async () => {
    const d = await deployment();
    const ac = new AbortController();
    const r = await get(d, "/endless", { signal: ac.signal });
    const reader = r.body!.getReader();
    await reader.read();
    await Bun.sleep(40);
    ac.abort();
    await Bun.sleep(50);
    const [, , ticks] = await d.read();
    expect(ticks).toBeGreaterThan(0);
    await Bun.sleep(100);
    expect((await d.read())[2]).toBe(ticks);
  });

  test("a fetch made after its end (an operation's continuation) is refused, with the same words", async () => {
    const d = await deployment();
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    stops.push(() => target.stop(true));
    await (await get(d, "/fetchLater", { method: "POST", body: `http://127.0.0.1:${target.port}/` })).text();
    await Bun.sleep(100);
    expect((await d.read())[3]).toEqual([["Error", ACTION_ENDED_MESSAGE]]);
  });
});

describe("trackedActionTimers (the function sandbox's child)", () => {
  test("the timers handed to it are cleared by its end; one handed over after it, at once", async () => {
    let fired = 0;
    const run = trackedActionTimers(() => {
      trackActionTimer(setTimeout(() => fired++, 20));
      return 7;
    });
    expect(run.value).toBe(7);
    run.end();
    await Bun.sleep(60);
    expect(fired).toBe(0);
  });
});
