// Queries and mutations over the bridge (STUDY-171 §8.9): the same pushed code deployed to a server running it in
// `vm` and to one running it in `process`, every case called on both, and what the client gets compared: the value,
// or the error's first line (`Uncaught Error: …`) and its data. The frames under it are PR 4's (stacks): only their
// first lines are compared here.
//
// The cases cover what a query or mutation reaches of `ctx`: `db` (reads, the query chain and its synchronous
// errors, writes and their value checks, `normalizeId`, `db.system`, `db.table`, `db.vars`), `auth`, `meta`,
// `scheduler`, `storage`, nested `runQuery` / `runMutation`, `createFunctionHandle`, `process.env`, the
// deterministic globals, thrown values of every kind, and results that are not values. Each returns what does not
// depend on the deployment (ids and times differ between the two servers): lengths, types, messages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));

/** Query cases: `ctx` is a query's, `a` the call's argument. */
const QUERY_CASES = `{
  empty: async () => null,
  getMissingTable: async (ctx) => (await ctx.db.query("nope").collect()).length,
  getBadId: async (ctx) => ctx.db.get("nope"),
  getBadIdTwoArgs: async (ctx) => ctx.db.get("items", "nope"),
  getOtherTable: async (ctx, a) => ctx.db.get("other", a),
  getOne: async (ctx, a) => { const d = await ctx.db.get(a); return d && [d.k, typeof d._creationTime, d._id === a]; },
  getTwoArgs: async (ctx, a) => (await ctx.db.get("items", a))?.k ?? null,
  collect: async (ctx) => (await ctx.db.query("items").collect()).map((d) => d.k),
  take: async (ctx) => (await ctx.db.query("items").take(2)).map((d) => d.k),
  takeBad: async (ctx) => { try { ctx.db.query("items").take(-1); } catch (e) { return [e.name, e.message]; } },
  takeUndefined: async (ctx) => { try { ctx.db.query("items").take(); } catch (e) { return [e.name, e.message]; } },
  first: async (ctx) => (await ctx.db.query("items").order("desc").first())?.k,
  firstEmpty: async (ctx) => ctx.db.query("other").first(),
  unique: async (ctx) => (await ctx.db.query("items").unique())?.k,
  uniqueOne: async (ctx) => (await ctx.db.query("items").withIndex("by_k", (q) => q.eq("k", 2)).unique())?.k,
  index: async (ctx) => (await ctx.db.query("items").withIndex("by_k", (q) => q.gt("k", 1).lte("k", 3)).collect()).map((d) => d.k),
  indexDesc: async (ctx) => (await ctx.db.query("items").withIndex("by_k").order("desc").collect()).map((d) => d.k),
  indexBadRange: async (ctx) => { try { ctx.db.query("items").withIndex("by_k", (q) => q.eq("nope", 1)); return "no throw"; } catch (e) { return ["sync", e.message]; } },
  indexTwoLower: async (ctx) => { try { ctx.db.query("items").withIndex("by_k", (q) => q.gt("k", 1).gte("k", 2)); return "no throw"; } catch (e) { return ["sync", e.message]; } },
  indexOrder: async (ctx) => { try { ctx.db.query("items").withIndex("by_k_s", (q) => q.eq("s", "a")); return "no throw"; } catch (e) { return ["sync", e.message]; } },
  indexMissing: async (ctx) => ctx.db.query("items").withIndex("nope").collect(),
  indexBuilderReturnsNothing: async (ctx) => { try { ctx.db.query("items").withIndex("by_k", (q) => { q.eq("k", 1); }); } catch (e) { return [e.name, e.message]; } },
  filter: async (ctx) => (await ctx.db.query("items").filter((q) => q.and(q.gte(q.field("k"), 2), q.neq(q.field("s"), "c"))).collect()).map((d) => d.k),
  filterArith: async (ctx) => (await ctx.db.query("items").filter((q) => q.eq(q.mod(q.field("k"), 2), 1)).collect()).map((d) => d.k),
  filterOr: async (ctx) => (await ctx.db.query("items").filter((q) => q.or(q.eq(q.field("k"), 1), q.not(q.lt(q.field("k"), 3)))).collect()).map((d) => d.k),
  filterLiteral: async (ctx) => (await ctx.db.query("items").filter(() => true).collect()).length,
  filterNotBool: async (ctx) => ctx.db.query("items").filter((q) => q.field("k")).collect(),
  filterUndefined: async (ctx) => (await ctx.db.query("items").filter((q) => q.eq(q.field("missing"), undefined)).collect()).length,
  filterBigint: async (ctx) => (await ctx.db.query("items").filter((q) => q.eq(q.field("k"), 2n)).collect()).length,
  filterNotFunction: async (ctx) => { try { ctx.db.query("items").filter(5); } catch (e) { return [e.name, e.message]; } },
  filterCommitTs: async (ctx) => ctx.db.query("items").filter(() => ({ x: 1 })).collect(),
  limitOps: async (ctx) => (await ctx.db.query("items").limit(3).filter((q) => q.gt(q.field("k"), 1)).collect()).map((d) => d.k),
  limitBad: async (ctx) => ctx.db.query("items").limit(-2).collect(),
  orderTwice: async (ctx) => { try { ctx.db.query("items").order("asc").order("desc"); } catch (e) { return e.message; } },
  reused: async (ctx) => { const q = ctx.db.query("items"); q.order("asc"); try { q.order("desc"); } catch (e) { return e.message; } },
  reusedAfterCollect: async (ctx) => { const q = ctx.db.query("items"); await q.collect(); try { await q.collect(); } catch (e) { return e.message; } },
  fullScan: async (ctx) => (await ctx.db.query("items").fullTableScan().take(1)).length,
  paginate: async (ctx) => {
    const p1 = await ctx.db.query("items").withIndex("by_k").paginate({ numItems: 2, cursor: null });
    const p2 = await ctx.db.query("items").withIndex("by_k").paginate({ numItems: 2, cursor: p1.continueCursor });
    return [p1.page.map((d) => d.k), p1.isDone, p2.page.map((d) => d.k), p2.isDone, typeof p2.continueCursor];
  },
  paginateBad: async (ctx) => ctx.db.query("items").paginate({ numItems: -1, cursor: null }),
  paginateNoOpts: async (ctx) => ctx.db.query("items").paginate(),
  paginateBadCursor: async (ctx) => ctx.db.query("items").paginate({ numItems: 1, cursor: "garbage" }),
  count: async (ctx) => ctx.db.query("items").count(),
  iterate: async (ctx) => { const out = []; for await (const d of ctx.db.query("items").withIndex("by_k")) { out.push(d.k); if (out.length === 2) break; } return out; },
  iterateAll: async (ctx) => { const out = []; for await (const d of ctx.db.query("items")) out.push(d.k); return out; },
  iterateTwice: async (ctx) => { const q = ctx.db.query("items"); q[Symbol.asyncIterator](); try { q[Symbol.asyncIterator](); } catch (e) { return e.message; } },
  systemTableQuery: async (ctx) => { try { ctx.db.query("_storage"); } catch (e) { return e.message; } },
  queryNotString: async (ctx) => { try { ctx.db.query(5); } catch (e) { return [e.name, e.message]; } },
  system: async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length,
  systemStorage: async (ctx) => (await ctx.db.system.query("_storage").withIndex("by_creation_time").collect()).length,
  systemBadIndex: async (ctx) => { try { ctx.db.system.query("_storage").withIndex("by_k"); } catch (e) { return e.message; } },
  systemUserTable: async (ctx) => { try { ctx.db.system.query("items"); } catch (e) { return e.message; } },
  systemPrivate: async (ctx) => (await ctx.db.system.query("_tables").collect()).length,
  systemGetUser: async (ctx, a) => ctx.db.system.get(a),
  normalizeId: async (ctx, a) => [ctx.db.normalizeId("items", a) === a, ctx.db.normalizeId("other", a), ctx.db.normalizeId("nope", a), ctx.db.normalizeId("items", "junk")],
  normalizeSystem: async (ctx, a) => { try { ctx.db.normalizeId("_storage", a); } catch (e) { return [e.message, ctx.db.system.normalizeId("_storage", a)]; } },
  normalizeSystemUser: async (ctx, a) => { try { ctx.db.system.normalizeId("items", a); } catch (e) { return e.message; } },
  table: async (ctx, a) => [(await ctx.db.table("items").get(a))?.k, (await ctx.db.table("items").query().take(1)).length, typeof ctx.db.table("items").insert],
  tableGetMissingArg: async (ctx) => ctx.db.table("items").get(),
  vars: async (ctx) => [ctx.db.vars === undefined, typeof ctx.db.insert],
  insertInQuery: async (ctx) => ctx.db.insert("items", { k: 9 }),
  patchInQuery: async (ctx, a) => ctx.db.patch(a, { k: 9 }),
  auth: async (ctx) => ctx.auth.getUserIdentity(),
  metaFunction: async (ctx) => ctx.meta.getFunctionMetadata(),
  metaDeployment: async (ctx) => (await ctx.meta.getDeploymentMetadata()).class,
  metaSnapshot: async (ctx) => typeof ctx.meta.getSnapshotTs(),
  metaMetrics: async (ctx) => { await ctx.db.query("items").collect(); const m = await ctx.meta.getTransactionMetrics(); return [m.documentsRead.used, m.databaseQueries.used, m.bytesRead.used > 0]; },
  metaRequest: async (ctx) => typeof ctx.meta.getRequestMetadata,
  nested: async (ctx) => ctx.runQuery("cases:q", { c: "collect" }),
  nestedThrows: async (ctx) => { try { await ctx.runQuery("cases:q", { c: "throwError" }); } catch (e) { return [e.message, e instanceof Error]; } },
  nestedMissing: async (ctx) => ctx.runQuery("cases:nope", {}),
  nestedStale: async (ctx) => { try { ctx.runQuery("cases:q", { c: "empty" }, { useStaleSnapshot: true }); } catch (e) { return e.message; } },
  nestedRunMutation: async (ctx) => typeof ctx.runMutation,
  handle: async (ctx) => (await createFunctionHandle(api.cases.q)).startsWith("function://"),
  storageUrl: async (ctx) => ctx.storage.getUrl("nope"),
  env: async () => [process.env.ENV_SET, process.env.ENV_UNSET, "ENV_SET" in process.env],
  envBadName: async () => { try { return process.env["bad name"]; } catch (e) { return e.message; } },
  envConstructor: async () => process.env.constructor,
  now: async () => [Date.now() === new Date().getTime(), typeof performance.now(), performance.now() === performance.now()],
  random: async () => { const r = Math.random(); const b = crypto.getRandomValues(new Uint8Array(4)); return [r >= 0 && r < 1, b.length, typeof crypto.randomUUID()]; },
  timer: async () => { setTimeout(() => {}, 0); return 1; },
  fetch: async () => { try { await fetch("http://127.0.0.1:1"); } catch (e) { return e.message; } },
  throwError: async () => { throw new Error("mine"); },
  throwTypeError: async () => { null.x; },
  throwCustom: async () => { class Oops extends Error { name = "Oops"; } throw new Oops("custom"); },
  throwBunvex: async () => { throw new BunvexError({ code: 7, n: 2n }); },
  throwBunvexString: async () => { throw new BunvexError("plain"); },
  throwString: async () => { throw "a string"; },
  throwObject: async () => { throw { a: 1 }; },
  throwUndefined: async () => { throw undefined; },
  opErrorCaught: async (ctx) => { try { await ctx.db.get("nope"); } catch (e) { return [e.message, e.name, e instanceof Error, typeof e.stack]; } },
  opErrorRethrown: async (ctx) => { try { await ctx.db.get("nope"); } catch (e) { throw e; } },
  returnQuery: async (ctx) => ctx.db.query("items"),
  returnFunction: async () => ({ f: () => 1 }),
  returnDate: async () => new Date(0),
  returnUndefinedField: async () => ({ a: undefined, b: 1 }),
  returnSpecial: async () => [NaN, -0, Infinity, 2n ** 70n, new ArrayBuffer(3)],
  returnBigint: async () => 2n ** 63n,
  returnNested: async () => { let x = 1; for (let i = 0; i < 70; i++) x = [x]; return x; },
  returnDollar: async () => ({ $bad: 1 }),
  returnLarge: async () => "x".repeat(17 * 1024 * 1024),
  argsEcho: async (ctx, a) => a,
  concurrentGets: async (ctx) => { const all = await ctx.db.query("items").collect(); return (await Promise.all(all.map((d) => ctx.db.get(d._id)))).map((d) => d.k); },
  concurrentNested: async (ctx) => (await Promise.all([1, 2, 3].map(() => ctx.runQuery("cases:q", { c: "count" })))),
  concurrentMixed: async (ctx) => { const [a, b, c] = await Promise.all([ctx.db.query("items").first(), ctx.runQuery("cases:q", { c: "env" }), ctx.meta.getFunctionMetadata()]); return [a.k, b, c.name]; },
  builtNotRun: async (ctx) => { ctx.db.query("never"); ctx.db.query("items").withIndex("by_k"); return 1; },
  partialIteration: async (ctx) => { for await (const d of ctx.db.query("items").withIndex("by_k")) return d.k; },
}`;

/** Mutation cases. */
const MUTATION_CASES = `{
  insert: async (ctx) => { const id = await ctx.db.insert("items", { k: 10, s: "z" }); const d = await ctx.db.get(id); await ctx.db.delete(id); return [typeof id, d.k, d.s]; },
  insertNewTable: async (ctx) => { const id = await ctx.db.insert("fresh", { a: 1 }); return [ctx.db.normalizeId("fresh", id) === id, (await ctx.db.query("fresh").collect()).length]; },
  insertBadTable: async (ctx) => ctx.db.insert("9lives", { k: 1 }),
  insertSystem: async (ctx) => ctx.db.insert("_storage", {}),
  insertNotObject: async (ctx) => ctx.db.insert("items", 5),
  insertMissing: async (ctx) => ctx.db.insert("items"),
  insertSet: async (ctx) => ctx.db.insert("items", { v: new Set([1]) }),
  insertMap: async (ctx) => ctx.db.insert("items", { v: new Map([[1, 2]]) }),
  insertDate: async (ctx) => ctx.db.insert("items", { v: new Date(0) }),
  // A Set's or Map's entries print in the message, from either executor (STUDY-18 §9).
  insertSetEmpty: async (ctx) => ctx.db.insert("items", { v: new Set() }),
  insertSetMany: async (ctx) => ctx.db.insert("items", { v: new Set([1, "two", null, [3], { four: 4n }, undefined, NaN]) }),
  insertMapMany: async (ctx) => ctx.db.insert("items", { v: new Map([["a", 1], [2, [true]], [null, { b: "c" }]]) }),
  insertSetNested: async (ctx) => ctx.db.insert("items", { v: { x: 1, s: [0, new Set([new Set([1]), new Map([[1, 2]])])] } }),
  insertSetSubclass: async (ctx) => ctx.db.insert("items", { v: new (class Tags extends Set {})([new (class Index extends Map {})()]) }),
  insertSetCycle: async (ctx) => { const s = new Set([1]); s.add(s); const m = new Map(); m.set("me", m); s.add(m); return ctx.db.insert("items", { v: s }); },
  insertSetHuge: async (ctx) => ctx.db.insert("items", { v: new Set(Array.from({ length: 20000 }, (_, i) => i)) }),
  insertForgedBytes: async (ctx) => { const id = await ctx.db.insert("items", { k: 16, v: { [Symbol.toStringTag]: "ArrayBuffer", a: 1 } }); const d = await ctx.db.get(id); await ctx.db.delete(id); return d.v; },
  scheduleMap: async (ctx) => ctx.scheduler.runAfter(1000, "cases:m", { v: new Map([["k", new Set(["s"])]]) }),
  scheduleAtDate: async (ctx) => { const at = Date.now() + 60000; const id = await ctx.scheduler.runAt(new Date(at), "cases:m", { c: "empty" }); const job = await ctx.db.system.get(id); await ctx.scheduler.cancel(id); return job.scheduledTime === at; },
  scheduleAtDateSubclass: async (ctx) => { const id = await ctx.scheduler.runAt(new (class Day extends Date {})(Date.now() + 60000), "cases:m", { c: "empty" }); await ctx.scheduler.cancel(id); return typeof id; },
  runQuerySet: async (ctx) => ctx.runQuery("cases:q", { c: "argsEcho", a: new Set([1]) }),
  returnSet: async () => new Set([1, [2]]),
  returnMap: async () => ({ m: new Map([["a", new Date(0)]]) }),
  insertFunction: async (ctx) => ctx.db.insert("items", { v: () => 1 }),
  insertSymbol: async (ctx) => ctx.db.insert("items", { v: Symbol("s") }),
  insertUndefinedInArray: async (ctx) => ctx.db.insert("items", { v: [1, undefined] }),
  insertDollar: async (ctx) => ctx.db.insert("items", { $x: 1 }),
  insertCycle: async (ctx) => { const o = { a: 1 }; o.self = o; return ctx.db.insert("items", o); },
  insertDeep: async (ctx) => { let x = 1; for (let i = 0; i < 70; i++) x = { x }; return ctx.db.insert("items", { x }); },
  insertBigOverflow: async (ctx) => ctx.db.insert("items", { v: 2n ** 64n }),
  insertRef: async (ctx) => ctx.db.insert("items", { v: api.cases.q }),
  insertValues: async (ctx) => { const id = await ctx.db.insert("items", { k: 11, b: new ArrayBuffer(2), n: NaN, z: -0, big: 5n, u: undefined, arr: [1, "a", null] }); const d = await ctx.db.get(id); await ctx.db.delete(id); return [d.b.byteLength, Number.isNaN(d.n), Object.is(d.z, -0), d.big, "u" in d, d.arr]; },
  insertCommitTs: async (ctx) => { const id = await ctx.db.insert("items", { k: 12, at: ctx.db.vars.commitTs }); return [typeof id, typeof ctx.db.vars.commitTs]; },
  commitTsInArgs: async (ctx) => ctx.runQuery("cases:q", { c: "argsEcho", a: ctx.db.vars.commitTs }),
  commitTsScheduled: async (ctx) => ctx.scheduler.runAfter(1000, "cases:m", { c: "empty", a: ctx.db.vars.commitTs }),
  insertCommitTsNested: async (ctx) => { await ctx.db.insert("items", { k: 13, deep: { at: ctx.db.vars.commitTs } }); return 1; },
  patch: async (ctx, a) => { await ctx.db.patch(a, { s: "patched" }); const d = await ctx.db.get(a); await ctx.db.patch(a, { s: undefined }); return [d.s, "s" in (await ctx.db.get(a))]; },
  patchCreationTime: async (ctx, a) => ctx.db.patch(a, { _creationTime: 1 }),
  patchMissing: async (ctx) => ctx.db.patch("items", "nope", {}),
  patchNoValue: async (ctx, a) => ctx.db.patch(a),
  replace: async (ctx, a) => { const before = await ctx.db.get(a); await ctx.db.replace(a, { k: 99 }); const d = await ctx.db.get(a); await ctx.db.replace(a, { k: before.k, s: before.s }); return Object.keys(d).sort(); },
  replaceWrongTable: async (ctx, a) => ctx.db.replace("other", a, { k: 1 }),
  deleteTwice: async (ctx) => { const id = await ctx.db.insert("items", { k: 14 }); await ctx.db.delete(id); return ctx.db.delete(id); },
  tableWriter: async (ctx) => { const id = await ctx.db.table("items").insert({ k: 15 }); await ctx.db.table("items").delete(id); return typeof id; },
  vars: async (ctx) => [typeof ctx.db.vars, typeof ctx.db.vars.commitTs],
  notAwaited: async (ctx) => { ctx.db.insert("other", { k: 1 }); return 1; },
  countAfter: async (ctx) => (await ctx.db.query("other").collect()).length,
  schedule: async (ctx) => { const id = await ctx.scheduler.runAfter(1000, "cases:m", { c: "empty" }); const job = await ctx.db.system.get(id); await ctx.scheduler.cancel(id); return [typeof id, job.name, job.state.kind]; },
  scheduleMissing: async (ctx) => ctx.scheduler.runAfter(0, "nope:x", {}),
  scheduleBadTime: async (ctx) => ctx.scheduler.runAt(NaN, "cases:m", {}),
  scheduleRef: async (ctx) => { const id = await ctx.scheduler.runAfter(1000, api.cases.m, { c: "empty" }); await ctx.scheduler.cancel(id); return typeof id; },
  scheduleSet: async (ctx) => ctx.scheduler.runAfter(1000, "cases:m", { v: new Set() }),
  nestedMutation: async (ctx) => { const r = await ctx.runMutation("cases:m", { c: "insert" }); return r; },
  nestedQueryReader: async (ctx) => ctx.runQuery("cases:q", { c: "vars" }),
  nestedRollback: async (ctx) => { try { await ctx.runMutation("cases:m", { c: "insertThenThrow" }); } catch (e) { return [e.message, (await ctx.db.query("items").withIndex("by_k", (q) => q.eq("k", 77)).collect()).length]; } },
  insertThenThrow: async (ctx) => { await ctx.db.insert("items", { k: 77 }); throw new Error("rolled back"); },
  nestedBunvex: async (ctx) => { try { await ctx.runQuery("cases:q", { c: "throwBunvex" }); } catch (e) { return [e.data, e instanceof BunvexError, e.message]; } },
  nestedStale: async (ctx) => { await ctx.db.insert("other", { k: 2 }); return [await ctx.runQuery("cases:q", { c: "otherCount" }, { useStaleSnapshot: true }), await ctx.runQuery("cases:q", { c: "otherCount" })]; },
  nestedDepth: async (ctx, a) => (a > 0 ? ctx.runMutation("cases:m", { c: "nestedDepth", a: a - 1 }) : "bottom"),
  sameNow: async (ctx) => { const t = Date.now(); const [n] = await ctx.runQuery("cases:q", { c: "nowValue" }); return n === t; },
  perfCounts: async () => typeof performance.now(),
  requestMeta: async (ctx) => { const r = await ctx.meta.getRequestMetadata(); return [typeof r.requestId, r.scheduledFunctionId]; },
  metaFunction: async (ctx) => ctx.meta.getFunctionMetadata(),
  storageUpload: async (ctx) => typeof (await ctx.storage.generateUploadUrl()),
  rooms: async (ctx) => { try { return typeof ctx.rooms; } catch (e) { return "throws"; } },
  manyInserts: async (ctx, a) => { for (let i = 0; i < a; i++) await ctx.db.insert("bulk", { i }); return (await ctx.db.query("bulk").collect()).length; },
  throwAfterWrite: async (ctx) => { await ctx.db.insert("other", { k: 3 }); throw new Error("after write"); },
}`;

const CASES_MODULE = `
import { query, mutation, createFunctionHandle } from ${SERVER};
import { anyApi as api } from ${SERVER};
import { v, BunvexError } from ${VALUES};
const qcases = ${QUERY_CASES};
qcases.otherCount = async (ctx) => (await ctx.db.query("other").collect()).length;
qcases.nowValue = async () => [Date.now()];
const mcases = ${MUTATION_CASES};
export const q = query({ args: { c: v.string(), a: v.optional(v.any()) }, handler: (ctx, { c, a }) => qcases[c](ctx, a) });
export const m = mutation({ args: { c: v.string(), a: v.optional(v.any()), v: v.optional(v.any()) }, handler: (ctx, { c, a }) => mcases[c](ctx, a) });
export const strict = query({ args: { n: v.number() }, returns: v.string(), handler: async (ctx, { n }) => (n > 0 ? "ok" : n) });
export const raw = query(async (ctx, args) => args);
export const QUERY_NAMES = ${"Object.keys(qcases)"};
`;

type Outcome = { status: string; value?: unknown; errorMessage?: string; errorData?: unknown };

/** Ids and creation times: each deployment's own. */
const own = (t: string) => t.replace(/\b[0-9a-z]{31,37}\b/g, "<id>").replace(/\b1\d{12}(?:\.\d+)?\b/g, "<time>");

/**
 * What the client gets, without what differs between two deployments: the request id, ids and times, the frames
 * (PR 4's).
 */
function normalized(o: Outcome) {
  if (o.status === "success") return { value: JSON.parse(own(JSON.stringify(o.value ?? null))) };
  const message = (o.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "");
  return { error: own(message.split("\n")[0]!), data: o.errorData };
}

async function deployment(sandbox: "vm" | "process") {
  const schema = defineSchema({
    items: defineTable(v.any()).index("by_k", ["k"]).index("by_k_s", ["k", "s"]),
    other: defineTable(v.any()),
    bulk: defineTable(v.any()),
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
  });
  await s.codeReady;
  await engine.mutation(async (db) => {
    for (const [k, str] of [
      [1, "a"],
      [2, "b"],
      [3, "c"],
      [4, "d"],
    ] as const)
      await db.insert("items", { k, s: str });
  });
  const { version } = await s.deployCode([{ path: "cases.js", source: CASES_MODULE, environment: "isolate" }]);
  await engine.mutation(async (db) =>
    engine.environment.update(db, [{ name: "ENV_SET", value: "yes" }], Object.keys(functions.builtinEnv)),
  );
  const call = async (kind: "query" | "mutation", path: string, args: object): Promise<Outcome> =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as Outcome;
  const firstId = async () =>
    (await engine.query(async (db) => (await db.query("items").withIndex("by_k").first())!._id)) as string;
  return { s, engine, functions, call, firstId, version };
}

let vm: Awaited<ReturnType<typeof deployment>>;
let proc: Awaited<ReturnType<typeof deployment>>;
beforeAll(async () => {
  [vm, proc] = await Promise.all([deployment("vm"), deployment("process")]);
});
afterAll(async () => {
  await vm?.s.shutdown();
  await proc?.s.shutdown();
});

const QUERY_NAMES = [...QUERY_CASES.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
const MUTATION_NAMES = [...MUTATION_CASES.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
/** The argument a case takes: the first item's id, unless it says otherwise. */
const ARGS: Record<string, unknown> = { manyInserts: 50, nestedDepth: 3 };

describe("a query's outcome is the same in vm and in process", () => {
  for (const c of QUERY_NAMES)
    test(c, async () => {
      const [a, b] = await Promise.all([vm.firstId(), proc.firstId()]);
      const [x, y] = await Promise.all([
        vm.call("query", "cases:q", { c, a: ARGS[c] ?? a }),
        proc.call("query", "cases:q", { c, a: ARGS[c] ?? b }),
      ]);
      expect(normalized(y)).toEqual(normalized(x));
    });
});

describe("a mutation's outcome is the same in vm and in process", () => {
  for (const c of MUTATION_NAMES)
    test(c, async () => {
      const [a, b] = await Promise.all([vm.firstId(), proc.firstId()]);
      const x = await vm.call("mutation", "cases:m", { c, a: ARGS[c] ?? a });
      const y = await proc.call("mutation", "cases:m", { c, a: ARGS[c] ?? b });
      expect(normalized(y)).toEqual(normalized(x));
    });
});

// The intervals a query read, as subscriptions and OCC see them, the same on both: so a result is invalidated by the
// same writes. Each engine has its own index ids, document ids and creation times: an interval is named by its
// index's `table.index`, a document id in a key (a string of id characters) is `<id>`, a creation time (a float of
// this century's milliseconds) `<time>`.
describe("a query's read set is the same in vm and in process", () => {
  const ID_IN_KEY = /10(?:3[0-9]|6[1-9a-f]|7[0-9a]){31,37}(?=0[01])/g;
  const TIME_IN_KEY = /0dc27[0-9a-f]{13}/g;
  const readSet = async (d: Awaited<ReturnType<typeof deployment>>, c: string, a: unknown) => {
    const names = new Map<string, string>();
    for (const t of d.engine.catalog.tables.values())
      for (const ix of [t.byId, ...t.indexes.values()]) names.set(String(ix.id), `${t.name}.${ix.name}`);
    const body = d.functions.queryBody("cases:q", { c, a });
    return d.engine.query(async (db) => {
      await body(db).catch(() => {});
      const hex = (b: Uint8Array) =>
        Buffer.from(b).toString("hex").replace(ID_IN_KEY, "<id>").replace(TIME_IN_KEY, "<time>");
      return db.reads.map((i) => `${names.get(String(i.index)) ?? "?"} ${hex(i.lo)}..${hex(i.hi)}`).sort();
    });
  };
  for (const c of [
    "empty",
    "getOne",
    "collect",
    "take",
    "first",
    "index",
    "filter",
    "paginate",
    "count",
    "iterate",
    "partialIteration",
    "getMissingTable",
    "builtNotRun",
    "system",
    "normalizeId",
    "env",
    "nested",
    "metaSnapshot",
  ])
    test(c, async () => {
      const [a, b] = await Promise.all([vm.firstId(), proc.firstId()]);
      const [x, y] = await Promise.all([readSet(vm, c, a), readSet(proc, c, b)]);
      expect(y).toEqual(x);
      expect(y.length).toBeGreaterThan(0);
    });
});

describe("validators and arguments are the host's", () => {
  for (const [path, args] of [
    ["cases:strict", { n: 1 }],
    ["cases:strict", { n: -1 }],
    ["cases:strict", { n: "x" }],
    ["cases:strict", {}],
    ["cases:raw", { a: 1, b: [1, 2] }],
    ["cases:q", { c: 5 }],
  ] as const)
    test(`${path} ${JSON.stringify(args)}`, async () => {
      const [x, y] = await Promise.all([vm.call("query", path, args), proc.call("query", path, args)]);
      expect(normalized(y)).toEqual(normalized(x));
    });
});
