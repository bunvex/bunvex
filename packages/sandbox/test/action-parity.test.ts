// Actions over the bridge (STUDY-171 §12): the same pushed code deployed to a server running it in `vm` and to one
// running it in `process`, every case called on both, and what the client gets compared: the value, or the error's
// whole message (its frames, mapped to the module) and its data, and the log lines.
//
// The cases cover what an action reaches: `runQuery` / `runMutation` / `runAction` (and their errors), the
// scheduler, `auth`, `meta`, `process.env`, the real clock and timers, `fetch` (to a server of this test's: every
// kind of body each way, statuses, redirects, failures, aborts, a body streamed both ways), `ctx.storage` (`store`
// and `get` of small and large files, the other methods, their errors), `ctx.vectorSearch` (with and without a
// filter, its errors), rooms and presence, `createFunctionHandle`, the console, `log.audit`, thrown values of
// every kind, and results that are not values.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);
process.env.TZ = "UTC";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));

/** The target of the cases' `fetch`es: what each path answers. */
let target: ReturnType<typeof Bun.serve>;
const BIG = 3 * 1024 * 1024 + 17;
const bigBytes = () => {
  const b = new Uint8Array(BIG);
  for (let i = 0; i < BIG; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
};

/** Action cases: `ctx` is an action's, `a` the call's argument, `T` the target's origin. */
const ACTION_CASES = `{
  empty: async () => null,
  argsEcho: async (ctx, a) => a,
  runQuery: async (ctx) => ctx.runQuery("cases:q", { n: 2 }),
  runMutation: async (ctx) => { const id = await ctx.runMutation("cases:ins", { k: 5 }); return typeof id; },
  runAction: async (ctx) => ctx.runAction("cases:a", { c: "argsEcho", a: [1, "x"] }),
  runActionDeep: async (ctx, a) => (a > 0 ? ctx.runAction("cases:a", { c: "runActionDeep", a: a - 1 }) : "bottom"),
  nestedThrows: async (ctx) => { try { await ctx.runQuery("cases:boom", {}); } catch (e) { return [e.name, e.message, e instanceof Error, typeof e.stack]; } },
  nestedThrowsUncaught: async (ctx) => ctx.runQuery("cases:boom", {}),
  nestedAwaitedUncaught: async (ctx) => { const r = await ctx.runQuery("cases:boom", {}); return r; },
  nestedAwaitedBunvex: async (ctx) => { const r = await ctx.runMutation("cases:boomData", {}); return r; },
  nestedAwaitedAction: async (ctx) => { const r = await ctx.runAction("cases:a", { c: "throwError" }); return r; },
  nestedAwaitedBadArgs: async (ctx) => { const r = await ctx.runQuery("cases:q", { n: new Map([[1, 2]]) }); return r; },
  nestedStack: async (ctx) => { try { await ctx.runQuery("cases:boom", {}); } catch (e) { return e.stack.split("\\n").filter((l) => l.includes("cases.js")).length; } },
  fetchAwaitedFails: async () => { const r = await fetch("http://127.0.0.1:1/"); return r.status; },
  storageAwaitedFails: async (ctx) => { const b = await ctx.storage.get("nope"); return b; },
  nestedBunvex: async (ctx) => { try { await ctx.runMutation("cases:boomData", {}); } catch (e) { return [e.name, e.message, e.data]; } },
  nestedBunvexUncaught: async (ctx) => ctx.runMutation("cases:boomData", {}),
  nestedActionThrows: async (ctx) => ctx.runAction("cases:a", { c: "throwError" }),
  nestedMissing: async (ctx) => ctx.runQuery("cases:nope", {}),
  nestedBadArgs: async (ctx) => ctx.runQuery("cases:q", { n: new Set([1]) }),
  nestedBadArgsCaught: async (ctx) => { try { await ctx.runQuery("cases:q", { n: () => 1 }); } catch (e) { return [e.name, e.message]; } },
  nestedNotObject: async (ctx) => ctx.runQuery("cases:q", 5),
  nestedValidator: async (ctx) => ctx.runQuery("cases:q", { n: "x" }),
  nestedSystem: async (ctx) => ctx.runQuery("_system/frontend/getVersion", {}),
  schedule: async (ctx) => { const id = await ctx.scheduler.runAfter(60_000, "cases:ins", { k: 1 }); await ctx.scheduler.cancel(id); return typeof id; },
  scheduleBad: async (ctx) => ctx.scheduler.runAfter(-1, "cases:nope", {}),
  scheduleAt: async (ctx) => typeof (await ctx.scheduler.runAt(new Date(Date.now() + 60_000), "cases:ins", { k: 1 })),
  auth: async (ctx) => ctx.auth.getUserIdentity(),
  metaFunction: async (ctx) => ctx.meta.getFunctionMetadata(),
  metaRequest: async (ctx) => Object.keys(await ctx.meta.getRequestMetadata()),
  metaDeployment: async (ctx) => (await ctx.meta.getDeploymentMetadata()).class,
  metaKeys: async (ctx) => [Object.keys(ctx.meta), typeof ctx.meta.getTransactionMetrics, typeof ctx.meta.getSnapshotTs],
  ctxKeys: async (ctx) => [Object.keys(ctx), Object.keys(ctx.storage), Object.keys(ctx.scheduler), Object.keys(ctx.rooms), Object.keys(ctx.presence)],
  env: async () => [process.env.ENV_SET, process.env.ENV_UNSET, "ENV_SET" in process.env],
  envBadName: async () => { try { return process.env["bad name"]; } catch (e) { return e.message; } },
  clock: async () => { const t = Date.now(); await new Promise((r) => setTimeout(r, 15)); return [Date.now() - t >= 10, Math.random() !== Math.random()]; },
  handle: async () => (await createFunctionHandle(api.cases.q)).startsWith("function://"),
  serviceToken: async () => getServiceToken("ai-gateway"),
  audit: async () => log.audit({ a: 1 }),
  logLines: async () => { console.log("one", { a: [1, 2] }); console.warn("two"); await new Promise((r) => setTimeout(r, 1)); console.error("three", new Error("logged")); return 1; },
  logMany: async () => { for (let i = 0; i < 300; i++) console.log("line", i); return 300; },
  logAroundNested: async (ctx) => { console.log("before"); await ctx.runQuery("cases:logs", {}); console.log("after"); return 1; },
  throwError: async () => { throw new Error("mine"); },
  throwTypeError: async () => { null.x; },
  throwBunvex: async () => { throw new BunvexError({ code: 7, n: 2n }); },
  throwString: async () => { throw "a string"; },
  throwObject: async () => { throw { a: 1 }; },
  returnFunction: async () => ({ f: () => 1 }),
  returnClass: async () => { class Point { constructor() { this.x = 1; } } return new Point(); },
  returnSpecial: async () => [NaN, -0, Infinity, 2n ** 70n, new ArrayBuffer(3)],
  returnLarge: async () => "x".repeat(17 * 1024 * 1024),
  unawaited: async (ctx) => { ctx.runQuery("cases:q", { n: 1 }); ctx.scheduler.runAfter(60_000, "cases:ins", { k: 1 }); return 1; },
  unawaitedMeta: async (ctx) => { ctx.meta.getFunctionMetadata(); ctx.meta.getDeploymentMetadata(); ctx.meta.getRequestMetadata(); createFunctionHandle(api.cases.q); return 1; },
  unawaitedStorage: async (ctx) => { ctx.storage.generateUploadUrl(); ctx.storage.store(new Blob(["x"])); ctx.auth.getUserIdentity(); return 1; },
  unawaitedFetch: async (ctx, T) => { fetch(T + "/text"); fetch(T + "/slow").catch(() => {}); return 1; },
  unawaitedAfterAwait: async (ctx) => { const p = ctx.meta.getFunctionMetadata(); await new Promise((r) => setTimeout(r, 50)); ctx.runQuery("cases:q", { n: 1 }); await p; return 1; },
  unawaitedBigStore: async (ctx) => { ctx.storage.store(new Blob([new Uint8Array(3 * 1024 * 1024)])); ctx.storage.store(new Blob(["small"])); return 1; },
  unawaitedFetchBlob: async (ctx, T) => { fetch(T + "/echo", { method: "POST", body: new Blob([new Uint8Array(200000)]) }); return 1; },
  unawaitedFetchForm: async (ctx, T) => { const f = new FormData(); for (let i = 0; i < 6; i++) f.append("f" + i, new Blob(["file " + i]), "f" + i + ".txt"); fetch(T + "/echo", { method: "POST", body: f }); return 1; },
  unawaitedStores: async (ctx) => { for (let i = 0; i < 5; i++) ctx.storage.store(new Blob(["small " + i])); return 1; },
  awaitedAll: async (ctx) => { await ctx.meta.getFunctionMetadata(); await ctx.runQuery("cases:q", { n: 1 }); await ctx.storage.generateUploadUrl(); return 1; },
  // fetch
  fetchText: async (ctx, T) => { const r = await fetch(T + "/text"); return [r.status, r.statusText, r.ok, await r.text(), r.headers.get("x-mine"), r.url === T + "/text", r.redirected, r.type]; },
  fetchJson: async (ctx, T) => (await fetch(T + "/json")).json(),
  fetchHeaders: async (ctx, T) => (await fetch(T + "/echo", { headers: { "x-a": "1", "X-B": "two" } })).json(),
  fetchUserAgent: async (ctx, T) => [(await (await fetch(T + "/echo")).json()).ua, (await (await fetch(T + "/echo", { headers: { "user-agent": "mine" } })).json()).ua],
  fetchPostString: async (ctx, T) => (await fetch(T + "/echo", { method: "POST", body: "hello" })).json(),
  fetchPostBytes: async (ctx, T) => (await fetch(T + "/echo", { method: "PUT", body: new Uint8Array([1, 2, 3, 250]) })).json(),
  fetchPostBuffer: async (ctx, T) => (await fetch(T + "/echo", { method: "POST", body: new Uint8Array(200000).fill(9).buffer })).json(),
  fetchPostBlob: async (ctx, T) => (await fetch(T + "/echo", { method: "POST", body: new Blob(["blob body"], { type: "text/x-mine" }) })).json(),
  fetchPostParams: async (ctx, T) => (await fetch(T + "/echo", { method: "POST", body: new URLSearchParams({ a: "1", b: "two words" }) })).json(),
  fetchPostForm: async (ctx, T) => { const f = new FormData(); f.append("a", "1"); f.append("file", new Blob(["file body"], { type: "text/plain" }), "f.txt"); const r = await (await fetch(T + "/echo", { method: "POST", body: f })).json(); return [r.method, r.type.split(";")[0], r.length > 100, r.body.includes("file body"), r.body.includes('name="a"')]; },
  fetchPostStream: async (ctx, T) => { const s = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("chunk one,")); c.enqueue(new TextEncoder().encode("chunk two")); c.close(); } }); return (await fetch(T + "/echo", { method: "POST", body: s, duplex: "half" })).json(); },
  fetchPostBigStream: async (ctx, T) => { let n = 0; const s = new ReadableStream({ pull(c) { if (n++ < 40) c.enqueue(new Uint8Array(100000).fill(n)); else c.close(); } }); const r = await (await fetch(T + "/echo", { method: "POST", body: s, duplex: "half" })).json(); return [r.length, r.sum]; },
  fetchRequestObject: async (ctx, T) => (await fetch(new Request(T + "/echo", { method: "POST", body: "from a request", headers: { "x-r": "1" } }))).json(),
  fetchStatus: async (ctx, T) => { const r = await fetch(T + "/status/404"); return [r.status, r.ok, await r.text()]; },
  fetchNoContent: async (ctx, T) => { const r = await fetch(T + "/status/204"); return [r.status, r.body === null, await r.text()]; },
  fetchHead: async (ctx, T) => { const r = await fetch(T + "/text", { method: "HEAD" }); return [r.status, await r.text()]; },
  fetchRedirect: async (ctx, T) => { const r = await fetch(T + "/redirect/3"); return [r.status, r.redirected, r.url === T + "/text", await r.text()]; },
  fetchRedirectManual: async (ctx, T) => { const r = await fetch(T + "/redirect/1", { redirect: "manual" }); return [r.status, r.redirected, r.headers.get("location")]; },
  fetchRedirectError: async (ctx, T) => { try { await fetch(T + "/redirect/1", { redirect: "error" }); } catch (e) { return [e.name, e.message]; } },
  fetchRedirectTooMany: async (ctx, T) => { try { await fetch(T + "/redirect/25"); } catch (e) { return [e.name, e.message]; } },
  fetchRedirect307Stream: async (ctx, T) => { try { await fetch(T + "/redirect307", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }), duplex: "half" }); } catch (e) { return [e.name, e.message]; } },
  fetchRedirect307Body: async (ctx, T) => (await fetch(T + "/redirect307", { method: "POST", body: "again" })).json(),
  fetchScheme: async () => { try { await fetch("file:///etc/passwd"); } catch (e) { return [e.name, e.message]; } },
  fetchBadUrl: async () => { try { await fetch("not a url"); } catch (e) { return [e.name, e.message]; } },
  fetchRefused: async () => { try { await fetch("http://127.0.0.1:1/x?token=secret"); } catch (e) { return [e.name, e.message, e instanceof TypeError]; } },
  fetchRefusedUncaught: async () => fetch("http://127.0.0.1:1/x"),
  fetchMetadata: async () => { try { await fetch("http://169.254.169.254/latest/meta-data"); } catch (e) { return [e.name, e.message]; } },
  fetchAbortBefore: async (ctx, T) => { const c = new AbortController(); c.abort(); try { await fetch(T + "/slow", { signal: c.signal }); } catch (e) { return [e.name, e.message]; } },
  fetchAbortWaiting: async (ctx, T) => { const c = new AbortController(); setTimeout(() => c.abort(), 30); try { await fetch(T + "/slow", { signal: c.signal }); } catch (e) { return [e.name, e.message]; } },
  fetchAbortBody: async (ctx, T) => { const c = new AbortController(); const r = await fetch(T + "/slowBody", { signal: c.signal }); const reader = r.body.getReader(); const first = await reader.read(); c.abort(); try { await reader.read(); return "read"; } catch (e) { return [first.value.length, e.name, e.message]; } },
  fetchBodyFails: async (ctx, T) => { const r = await fetch(T + "/brokenBody"); try { await r.text(); return "read"; } catch (e) { return [e.name, e.message.replace(/:\\d+\\//, ":<port>/")]; } },
  fetchBodyTwice: async (ctx, T) => { const r = await fetch(T + "/text"); await r.text(); try { await r.text(); } catch (e) { return [e.name, e.message]; } },
  fetchBig: async (ctx, T) => { const r = await fetch(T + "/big"); const b = new Uint8Array(await r.arrayBuffer()); let sum = 0; for (const x of b) sum = (sum + x) % 1000003; return [b.length, sum, r.headers.get("content-length")]; },
  fetchBigStreamed: async (ctx, T) => { const r = await fetch(T + "/big"); let n = 0, chunks = 0; for await (const c of r.body) { n += c.length; chunks++; } return [n, chunks > 1]; },
  fetchBigUnread: async (ctx, T) => { const r = await fetch(T + "/big"); return r.status; },
  fetchBlob: async (ctx, T) => { const b = await (await fetch(T + "/json")).blob(); return [b.size, b.type, await b.text()]; },
  fetchClone: async (ctx, T) => { const r = await fetch(T + "/text"); const c = r.clone(); return [await r.text(), await c.text()]; },
  fetchConcurrent: async (ctx, T) => (await Promise.all([1, 2, 3, 4].map((i) => fetch(T + "/echo?i=" + i).then((r) => r.json())))).map((j) => j.url.endsWith("i=" + (j.url.slice(-1)))),
  fetchBunOptions: async (ctx, T) => (await fetch(T + "/echo", { verbose: false, timeout: 1, proxy: "http://127.0.0.1:1", unix: "/nope" })).json(),
  // storage
  storeSmall: async (ctx) => { const id = await ctx.storage.store(new Blob(["hello storage"], { type: "Text/Plain" })); const m = await ctx.storage.getMetadata(id); const b = await ctx.storage.get(id); return [typeof id, m.size, m.contentType, b.type, b.size, await b.text(), typeof (await ctx.storage.getUrl(id))]; },
  storeLarge: async (ctx, a) => { const bytes = new Uint8Array(a); for (let i = 0; i < a; i++) bytes[i] = (i * 13) & 0xff; const id = await ctx.storage.store(new Blob([bytes])); const b = await ctx.storage.get(id); const back = new Uint8Array(await b.arrayBuffer()); let same = back.length === a; for (let i = 0; same && i < a; i++) same = back[i] === bytes[i]; const m = await ctx.storage.getMetadata(id); return [b.size, b.type, same, m.size, m.sha256]; },
  storeEmpty: async (ctx) => { const id = await ctx.storage.store(new Blob([])); const b = await ctx.storage.get(id); return [b.size, b.type]; },
  storeFile: async (ctx) => { const id = await ctx.storage.store(new File(["a file"], "f.txt", { type: "application/json" })); return (await ctx.storage.getMetadata(id)).contentType; },
  storeSha: async (ctx) => { try { await ctx.storage.store(new Blob(["x"]), { sha256: "bad" }); } catch (e) { return [e.name, e.message]; } },
  storeNotBlob: async (ctx) => { try { await ctx.storage.store("text"); } catch (e) { return [e.name, e.message]; } },
  storeNotBlobUncaught: async (ctx) => ctx.storage.store({ a: 1 }),
  storeFromFetch: async (ctx, T) => { const id = await ctx.storage.store(await (await fetch(T + "/big")).blob()); return (await ctx.storage.getMetadata(id)).size; },
  getMissing: async (ctx) => { const id = await ctx.storage.store(new Blob(["x"])); await ctx.storage.delete(id); return [await ctx.storage.get(id), await ctx.storage.getUrl(id), await ctx.storage.getMetadata(id)]; },
  getBadId: async (ctx) => ctx.storage.get("nope"),
  getNotString: async (ctx) => ctx.storage.get(5),
  uploadUrl: async (ctx) => (await ctx.storage.generateUploadUrl()).includes("/api/storage/upload"),
  deleteBad: async (ctx) => ctx.storage.delete("nope"),
  // vector search
  vector: async (ctx) => (await ctx.vectorSearch("vecs", "by_v", { vector: [1, 0, 0], limit: 2 })).map((r) => [typeof r._id, r._score > 0]),
  vectorFilter: async (ctx) => (await ctx.vectorSearch("vecs", "by_v", { vector: [0, 1, 0], filter: (q) => q.eq("k", 2) })).length,
  vectorFilterOr: async (ctx) => (await ctx.vectorSearch("vecs", "by_v", { vector: [0, 1, 0], filter: (q) => q.or(q.eq("k", 1), q.eq("k", 3)) })).length,
  vectorFilterBad: async (ctx) => ctx.vectorSearch("vecs", "by_v", { vector: [0, 1, 0], filter: (q) => q.eq(5, 2) }),
  vectorFilterField: async (ctx) => ctx.vectorSearch("vecs", "by_v", { vector: [0, 1, 0], filter: (q) => q.eq("nope", 2) }),
  vectorEmpty: async (ctx) => ctx.vectorSearch("vecs", "by_v", { vector: [] }),
  vectorMissingArg: async (ctx) => ctx.vectorSearch("vecs", undefined, { vector: [1, 0, 0] }),
  vectorBadIndex: async (ctx) => ctx.vectorSearch("vecs", "nope", { vector: [1, 0, 0] }),
  vectorDims: async (ctx) => ctx.vectorSearch("vecs", "by_v", { vector: [1, 0] }),
  vectorLimit: async (ctx) => ctx.vectorSearch("vecs", "by_v", { vector: [1, 0, 0], limit: 0 }),
  // rooms
  roomsBroadcast: async (ctx) => ctx.rooms.broadcast(api.cases.lobby, {}, "ping", { n: 1 }),
  roomsBroadcastBadEvent: async (ctx) => ctx.rooms.broadcast(api.cases.lobby, {}, "nope", { n: 1 }),
  roomsBroadcastBadData: async (ctx) => ctx.rooms.broadcast(api.cases.lobby, {}, "ping", { n: "x" }),
  roomsMissing: async (ctx) => ctx.rooms.broadcast(api.cases.nope, {}, "ping", {}),
  roomsMembers: async (ctx) => ctx.rooms.members(api.cases.lobby, {}),
  roomsBadArgs: async (ctx) => ctx.rooms.members(api.cases.doc, { id: 5 }),
  presenceList: async (ctx) => ctx.presence.list(api.cases.here, {}),
  presenceNotRoom: async (ctx) => ctx.presence.list(api.cases.lobby, {}),
}`;

const CASES_MODULE = `
import { action, query, mutation, createFunctionHandle, getServiceToken, log, room, presence } from ${SERVER};
import { anyApi as api } from ${SERVER};
import { v, BunvexError } from ${VALUES};
const acases = ${ACTION_CASES};
// What an action leaves when it answers (STUDY-77 §7): module state the later calls read.
const late = { fired: 0, ticks: 0, kept: null, msgs: [] };
Object.assign(acases, {
  endTimer: async (ctx) => { setTimeout(async () => { late.fired++; try { await ctx.runMutation("cases:ins", { k: 100 }); } catch (e) { late.msgs.push(e.message); } }, 40); return 1; },
  endInterval: async () => { setInterval(() => { late.ticks++; }, 10); await new Promise((r) => setTimeout(r, 45)); return late.ticks > 0; },
  endFiresWhileRunning: async () => { let n = 0; await new Promise((r) => { const t = setInterval(() => { if (++n === 3) { clearInterval(t); r(); } }, 5); }); return n; },
  endKeep: async (ctx) => { late.kept = ctx; return 1; },
  endUseKept: async () => { const out = []; for (const call of [() => late.kept.runQuery("cases:q", { n: 1 }), () => late.kept.runMutation("cases:ins", { k: 101 }), () => late.kept.scheduler.runAfter(0, "cases:ins", { k: 102 }), () => late.kept.auth.getUserIdentity(), () => late.kept.meta.getFunctionMetadata(), () => late.kept.storage.generateUploadUrl()]) try { await call(); out.push("ran"); } catch (e) { out.push(e.message); } return out; },
  endContinuation: async (ctx, T) => { ctx.runQuery("cases:q", { n: 2 }).then(() => ctx.runMutation("cases:ins", { k: 103 })).catch((e) => late.msgs.push(e.message)); ctx.runQuery("cases:q", { n: 3 }).then(() => fetch(T + "/text")).then(() => late.msgs.push("fetched"), (e) => late.msgs.push(e.message)); ctx.runQuery("cases:q", { n: 4 }).then(() => setTimeout(() => { late.fired += 10; }, 5)); return 1; },
  endInFlight: async (ctx) => { ctx.runMutation("cases:ins", { k: 104 }); return 1; },
  endReport: async (ctx) => { const ks = (await ctx.runQuery("cases:items", {})).filter((k) => k >= 100).sort(); return { fired: late.fired, ticks: late.ticks, msgs: [...late.msgs].sort(), ks }; },
});
export const a = action({ args: { c: v.string(), a: v.optional(v.any()) }, handler: (ctx, { c, a }) => acases[c](ctx, a) });
export const q = query({ args: { n: v.number() }, handler: async (ctx, { n }) => n * 2 });
export const ins = mutation({ args: { k: v.number() }, handler: async (ctx, { k }) => ctx.db.insert("items", { k }) });
export const boom = query(async () => { throw new Error("callee failed"); });
export const boomData = mutation(async () => { throw new BunvexError({ why: "data", n: 1n }); });
export const items = query(async (ctx) => (await ctx.db.query("items").collect()).map((d) => d.k));
export const logs = query(async () => { console.log("in the callee"); return 1; });
export const strict = action({ args: { n: v.number() }, returns: v.string(), handler: async (ctx, { n }) => (n > 0 ? "ok" : n) });
export const lobby = room({ presence: v.any(), events: { ping: { n: v.number() } } });
export const doc = room({ args: { id: v.string() }, canJoin: async (ctx, { id }) => id !== "closed", presence: v.any() });
export const here = presence({ state: v.any() });
`;

/** Files in memory (the server's `BlobStore`; this package does not depend on `@bunvex/file-storage`). */
export class TestBlobs {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array) {
    const bytes = new Uint8Array(await new Response(body as Blob).arrayBuffer());
    const key = crypto.randomUUID();
    this.blobs.set(key, bytes);
    return {
      key,
      size: bytes.byteLength,
      sha256: new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest()),
    };
  }
  async get(key: string, range?: { start: number; end: number }) {
    const b = this.blobs.get(key);
    if (!b) return null;
    return new Blob([(range ? b.subarray(range.start, range.end + 1) : b) as Uint8Array<ArrayBuffer>]).stream();
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  async *list() {
    for (const key of this.blobs.keys()) yield { key, lastModified: 0 };
  }
}

type Outcome = { status: string; value?: unknown; errorMessage?: string; errorData?: unknown; logLines?: string[] };

const own = (t: string) =>
  t
    .replace(/\b[0-9a-z]{31,37}\b/g, "<id>")
    .replace(/\b1\d{12}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{16}\b/g, "<request>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/: \d+ms\b/g, ": <n>ms");

function normalized(o: Outcome) {
  const logLines = JSON.parse(own(JSON.stringify(o.logLines ?? [])));
  if (o.status === "success") return { value: JSON.parse(own(JSON.stringify(o.value ?? null))), logLines };
  const message = (o.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "");
  return { error: own(message), data: o.errorData, logLines };
}

async function deployment(sandbox: "vm" | "process") {
  const schema = defineSchema({
    items: defineTable(v.any()),
    vecs: defineTable(v.any()).vectorIndex("by_v", { vectorField: "v", dimensions: 3, filterFields: ["k"] }),
  });
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
    fileStorage: new TestBlobs(),
  });
  await s.codeReady;
  await engine.mutation(async (db) => {
    for (const [k, vec] of [
      [1, [1, 0, 0]],
      [2, [0, 1, 0]],
      [3, [0.5, 0.5, 0]],
    ] as const)
      await db.insert("vecs", { k, v: [...vec] });
  });
  await s.deployCode([{ path: "cases.js", source: CASES_MODULE, environment: "isolate" }]);
  await engine.mutation(async (db) =>
    engine.environment.update(db, [{ name: "ENV_SET", value: "yes" }], Object.keys(functions.builtinEnv)),
  );
  const call = async (path: string, args: object, kind = "action"): Promise<Outcome> =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as Outcome;
  return { s, engine, functions, call };
}

let vm: Awaited<ReturnType<typeof deployment>>;
let proc: Awaited<ReturnType<typeof deployment>>;
let T: string;
beforeAll(async () => {
  const big = bigBytes();
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/text") return new Response("plain text", { headers: { "x-mine": "yes" }, statusText: "Fine" });
      if (p === "/json") return Response.json({ a: [1, 2], b: "x" });
      if (p === "/echo") {
        const body = new Uint8Array(await req.arrayBuffer());
        let sum = 0;
        for (const x of body) sum = (sum + x) % 1000003;
        const headers = Object.fromEntries([...req.headers].filter(([k]) => k.startsWith("x-")));
        return Response.json({
          method: req.method,
          url: req.url,
          ua: req.headers.get("user-agent"),
          type: req.headers.get("content-type"),
          length: body.length,
          sum,
          body: body.length < 4096 ? new TextDecoder().decode(body) : null,
          headers,
        });
      }
      if (p.startsWith("/status/")) {
        const status = Number(p.slice(8));
        return new Response(status === 204 ? null : `status ${status}`, { status });
      }
      if (p.startsWith("/redirect/")) {
        const n = Number(p.slice(10));
        return new Response(null, { status: 302, headers: { location: n > 1 ? `/redirect/${n - 1}` : "/text" } });
      }
      if (p === "/redirect307") return new Response(null, { status: 307, headers: { location: "/echo" } });
      if (p === "/slow") {
        await Bun.sleep(2000);
        return new Response("late");
      }
      if (p === "/slowBody")
        return new Response(
          new ReadableStream({
            async pull(c) {
              c.enqueue(new Uint8Array(10));
              await Bun.sleep(500);
            },
          }),
        );
      if (p === "/brokenBody") {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("partial"));
              setTimeout(() => c.error(new Error("broken")), 20);
            },
          }),
          { headers: { "content-length": "1000" } },
        );
      }
      if (p === "/big") return new Response(big);
      return new Response("no", { status: 500 });
    },
  });
  T = `http://127.0.0.1:${target.port}`;
  [vm, proc] = await Promise.all([deployment("vm"), deployment("process")]);
});
afterAll(async () => {
  await vm?.s.shutdown();
  await proc?.s.shutdown();
  target?.stop(true);
});

const NAMES = [...ACTION_CASES.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
/** The argument a case takes: the target's origin, unless it says otherwise. */
const ARGS: Record<string, unknown> = {
  argsEcho: { x: [1, null, -0.5], y: "z" },
  runActionDeep: 4,
  storeLarge: 16 * 1024 * 1024 + 5,
};

describe("an action's outcome is the same in vm and in process", () => {
  for (const c of NAMES)
    test(c, async () => {
      const a = ARGS[c] ?? T;
      const [x, y] = await Promise.all([vm.call("cases:a", { c, a }), proc.call("cases:a", { c, a })]);
      expect(normalized(y)).toEqual(normalized(x));
    }, 30_000);
});

describe("validators and arguments are the host's", () => {
  for (const args of [{ n: 1 }, { n: -1 }, { n: "x" }, {}])
    test(JSON.stringify(args), async () => {
      const [x, y] = await Promise.all([vm.call("cases:strict", args), proc.call("cases:strict", args)]);
      expect(normalized(y)).toEqual(normalized(x));
    });
});

describe("what an action did stays done, as under vm", () => {
  test("its writes, its scheduled jobs and its files", async () => {
    const count = async (d: typeof vm) =>
      d.engine.query(async (db) => [
        (await db.query("items").collect()).length,
        (await db.system.query("_scheduled_functions").collect()).length,
        (await db.system.query("_storage").collect()).length,
      ]);
    expect(await count(proc)).toEqual(await count(vm));
  });
});

// Rooms (AD-42) are stand-ins under `process`, their gates queries run in the child: a join is let in or not as under
// `vm`, and a gate's error is the same.
describe("a room's gate decides as under vm", () => {
  for (const [name, which, args] of [
    ["cases:doc", "canJoin", { id: "open" }],
    ["cases:doc", "canJoin", { id: "closed" }],
  ] as const)
    test(`${name}#${which} ${JSON.stringify(args)}`, async () => {
      const gate = async (d: typeof vm) => {
        const def = d.functions.rooms.get(name) as unknown as Record<string, unknown>;
        return d.functions.runGate(def[which] as never, `${name}#${which}`, args, { identity: null } as never);
      };
      const [x, y] = await Promise.all([gate(vm), gate(proc)]);
      expect(y).toEqual(x);
    });

  test("the definitions are the same: their kinds, validators and gates", () => {
    const view = (d: typeof vm) =>
      [...d.functions.rooms].map(([k, r]) => {
        const o = r as unknown as Record<string, unknown>;
        const json = (x: unknown) => (x as { json?: unknown } | undefined)?.json ?? null;
        return [
          k,
          o.kind,
          json(o.args),
          json(o.presence ?? o.state),
          Object.fromEntries(Object.entries((o.events as Record<string, unknown>) ?? {}).map(([e, x]) => [e, json(x)])),
          typeof o.canJoin,
          typeof o.canPublish,
        ];
      });
    expect(view(proc)).toEqual(view(vm));
    expect(view(vm).length).toBe(3);
  });
});

// What an action leaves when it answers (STUDY-77 §7, owner 2026-10-21): under both executors as Convex, its timers
// cleared, its ctx and fetch refusing afterwards, what was in flight finished.
describe("an action ends with its answer, as under vm", () => {
  test("its timers, its kept ctx, its continuations, what was in flight", async () => {
    const play = async (d: typeof vm) => {
      const call = async (c: string) => normalized(await d.call("cases:a", { c, a: T }));
      const answers = [];
      for (const c of ["endFiresWhileRunning", "endTimer", "endInterval", "endKeep", "endContinuation", "endInFlight"])
        answers.push(await call(c));
      const ticks = (await call("endReport")).value as { ticks: number };
      await Bun.sleep(200);
      answers.push(await call("endUseKept"));
      const report = (await call("endReport")).value as { ticks: number };
      return { answers, report, intervalStopped: report.ticks === ticks.ticks };
    };
    const [x, y] = await Promise.all([play(vm), play(proc)]);
    const ended = "the action has ended: its operations can no longer run";
    for (const r of [x, y]) {
      expect(r.answers[0]).toEqual({ value: 3, logLines: [] });
      expect(r.answers.at(-1)).toEqual({ value: Array(6).fill(ended), logLines: [] });
      expect(r.intervalStopped).toBe(true);
    }
    const { ticks: _a, ...rx } = x.report as Record<string, unknown>;
    const { ticks: _b, ...ry } = y.report as Record<string, unknown>;
    expect(ry).toEqual(rx);
    expect(rx).toEqual({ fired: 0, msgs: [ended, ended], ks: [104] });
  });
});
