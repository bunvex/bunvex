// Queries and mutations over the bridge (STUDY-171 §8.9, §11.5): the same pushed code deployed to a server running it
// in `vm` and to one running it in `process`, every case called on both, and what the client gets compared: the
// value, or the error's whole message (its frames, mapped to the module) and its data, and the log lines.
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
// Functions run in UTC, as `bunvex-local-backend` sets it (STUDY-171 §10); the child's is always UTC.
process.env.TZ = "UTC";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
/** An event of the log stream, as a sink gets it (log-events.ts). */
type LogEvent = { timestamp: number; event: { topic: string } & Record<string, unknown> };
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
  // A query's states (STUDY-188 §X9): each step's outcome on the same query, its message when it fails.
  queryStates: async (ctx) => {
    const m = async (f) => { try { const r = await f(); return Array.isArray(r) ? r.length : r && typeof r === "object" && "done" in r ? r.done : String(r); } catch (e) { return e.message; } };
    const scan = () => ctx.db.query("items").fullTableScan();
    const out = [];
    let q = scan(); out.push(await m(async () => { for await (const _ of q); }), await m(async () => { for await (const _ of q); }));
    q = scan(); out.push(await m(() => q.collect()), await m(() => q.collect()), await m(() => q.take(1)), await m(() => q.filter(() => true)));
    q = scan(); out.push(await m(() => q.take(1)), await m(async () => { for await (const _ of q); }), await m(() => q.first()));
    q = scan(); out.push(q[Symbol.asyncIterator]() === q, await m(() => q.next()), await m(() => q.collect()), await m(() => q.order("asc")), await m(() => q.next()), await m(() => q.next()), await m(() => q.next()));
    q = scan(); out.push(await m(async () => { for await (const _ of q) break; }), await m(() => q.next()));
    q = scan(); out.push(await m(() => q.return()), await m(() => q.collect()));
    q = ctx.db.query("items"); out.push(await m(() => q.collect()), await m(() => q.collect()), await m(async () => { for await (const _ of q); }), typeof q.next);
    q = ctx.db.query("items").withIndex("nope"); out.push(await m(() => q.collect()), await m(() => q.collect()), await m(async () => { for await (const _ of q); }));
    q = ctx.db.query("items").order("asc"); out.push(await m(() => q.order("desc")), await m(() => q.collect()));
    q = ctx.db.system.query("_scheduled_functions"); out.push(await m(() => q.collect()), await m(() => q.collect()), typeof q.next);
    q = ctx.db.system.query("_scheduled_functions").fullTableScan(); out.push(q[Symbol.asyncIterator]() === q, await m(() => q.next()), await m(() => q.next()));
    // A start that fails throws from \`[Symbol.asyncIterator]()\` itself, and leaves the query preparing.
    const start = (q) => { try { return q[Symbol.asyncIterator]() === q; } catch (e) { return "sync: " + e.message; } };
    q = ctx.db.query("items").withIndex("nope"); out.push(start(q), start(q), await m(() => q.next()), await m(() => q.filter(() => true)));
    q = ctx.db.query("nope").withIndex("by_k"); out.push(start(q), await m(() => q.collect()));
    q = ctx.db.query("items").withIndex("search_s"); out.push(start(q));
    q = ctx.db.query("items").limit(-1); out.push(start(q), await m(() => q.limit(1)));
    // One that fails after its start (a document its filter cannot evaluate) is still executing.
    const partway = () => ctx.db.query("items").filter((f) => f.or(f.eq(f.field("k"), 1), f.eq(f.neg(f.field("nope")), 0)));
    q = partway(); out.push(await m(() => q.collect()), await m(() => q.filter(() => true)), await m(() => q.collect()), await m(() => q.next()), await m(() => q.next()));
    q = partway(); out.push(await m(async () => { for await (const _ of q); }), await m(() => q.next()), await m(() => q.order("asc")));
    return out;
  },
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
  logLevels: async () => { console.log("log", 1); console.info("info"); console.warn("warn"); console.error("error"); console.debug("debug"); return 1; },
  logValues: async () => { console.log("s", 'q"uote', 1.5, -0, NaN, 2n, true, null, undefined, Symbol("sym"), "é ☃ 𝄞"); return 1; },
  logObjects: async () => { class Point { constructor() { this.x = 1; } } console.log({ a: 1, nested: { b: [1, { c: 2 }] } }, [1, [2, [3]]], new Point(), Object.create(null), () => 1, function named() {}); return 1; },
  logCollections: async () => { console.log(new Set([1, "a"]), new Map([["k", { v: 1 }]]), new Date(0), new Uint8Array([1, 2]), new ArrayBuffer(2), /re/g); return 1; },
  logErrors: async () => { console.log(new Error("logged")); console.error(new TypeError("typed"), { e: new RangeError("inner") }); return 1; },
  logOpError: async (ctx) => { try { await ctx.db.get("nope"); } catch (e) { console.log(e); console.log(e.message, e.stack); } return 1; },
  logDoc: async (ctx, a) => { const d = await ctx.db.get(a); console.log(d, [d], { doc: d }); console.log(await ctx.db.query("items").take(2)); return 1; },
  logNone: async () => { console.log(); return 1; },
  logLoneSurrogate: async () => { console.log("a\uD800b", "\uDC00"); return 1; },
  logLong: async () => { console.log("x".repeat(40000)); return 1; },
  logLongArgs: async () => { console.log("a".repeat(20000), "b".repeat(20000), "c"); return 1; },
  logLongMultibyte: async () => { console.log("é".repeat(20000)); console.log("𝄞".repeat(9000)); return 1; },
  logLongObject: async () => { console.log({ s: "y".repeat(40000) }); return 1; },
  logMany: async () => { for (let i = 0; i < 300; i++) console.log("line", i); return 1; },
  logExactlyMax: async () => { for (let i = 0; i < 256; i++) console.log(i); return 1; },
  logJustUnder: async () => { for (let i = 0; i < 255; i++) console.log(i); return 1; },
  logTimers: async () => { console.time(); console.time(); console.timeLog(); console.timeLog("x", 1, { a: 1 }); console.time("t"); console.timeLog("t", "more"); console.timeEnd("t"); console.timeEnd("t"); console.timeEnd(); return 1; },
  logTrace: async () => { console.trace("traced", { a: 1 }); return 1; },
  logThenThrow: async () => { console.log("before"); throw new Error("after logging"); },
  logThenThrowBunvex: async () => { console.warn("data next"); throw new BunvexError({ code: 1 }); },
  logNested: async (ctx) => { console.log("outer 1"); const r = await ctx.runQuery("cases:q", { c: "logLevels" }); console.log("outer 2", r); await ctx.runQuery("cases:q", { c: "logValues" }); console.log("outer 3"); return r; },
  logNestedThrows: async (ctx) => { console.log("calling"); try { await ctx.runQuery("cases:q", { c: "logThenThrow" }); } catch (e) { console.log("caught", e.message); } return 1; },
  logNestedUncaught: async (ctx) => { console.log("calling"); await ctx.runQuery("cases:q", { c: "logThenThrow" }); },
  logNestedMany: async (ctx) => { for (let i = 0; i < 200; i++) console.log("outer", i); await ctx.runQuery("cases:q", { c: "logMany" }); console.log("after"); return 1; },
  logConcurrent: async (ctx) => { const all = await Promise.all([1, 2, 3].map(async (i) => { console.log("start", i); const d = await ctx.db.query("items").first(); console.log("end", i); return d.k; })); return all; },
  logBetweenOps: async (ctx) => { console.log("a"); await ctx.db.query("items").first(); console.log("b"); await ctx.db.query("items").first(); console.log("c"); return 1; },
  logGetterThrows: async () => { console.log({ get x() { throw new Error("getter"); } }); return 1; },
  logOther: async () => { console.assert(false, "asserted"); console.count(); console.dir({ a: 1 }); console.table([{ a: 1 }]); console.group("g"); console.groupEnd(); return 1; },
  nestedUncaughtFrames: async (ctx) => ctx.runQuery("cases:q", { c: "throwError" }),
  deepThrow: async () => { const f = (n) => { if (n === 0) throw new Error("deep"); return f(n - 1) + 1; }; return f(20); },
  throwFromHelper: async () => { function helper() { throw new RangeError("from helper"); } helper(); },
  throwCaughtStack: async () => { try { null.x; } catch (e) { return e.stack; } },
  opErrorStack: async (ctx) => { try { await ctx.db.get("nope"); } catch (e) { return e.stack; } },
  linkErrorStack: async (ctx) => { try { await ctx.db.query("items").withIndex("nope").collect(); } catch (e) { return e.stack; } },
  audit: async () => { await log.audit({ a: 1, who: log.vars.requestId, nested: [{ at: log.vars.now }] }); return 1; },
  auditDollar: async () => log.audit({ $bad: 1 }),
  auditDollarCaught: async () => { try { await log.audit({ ok: { $bad: 1 } }); } catch (e) { return [e.message, e.stack]; } },
  auditUnknownVar: async () => log.audit({ v: Symbol("nope") }),
  auditNested: async (ctx) => { await log.audit({ outer: 1 }); await ctx.runQuery("cases:q", { c: "audit" }); return 1; },
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
  logInMutation: async (ctx) => { console.log("m1"); await ctx.db.insert("other", { k: 4 }); console.info("m2"); return 1; },
  logNestedMutation: async (ctx) => { console.log("outer"); await ctx.runMutation("cases:m", { c: "logInMutation" }); await ctx.runQuery("cases:q", { c: "logLevels" }); console.log("outer end"); return 1; },
  logNestedRollback: async (ctx) => { try { await ctx.runMutation("cases:m", { c: "logThenRollback" }); } catch (e) { console.log("rolled back:", e.message); } return 1; },
  logThenRollback: async (ctx) => { console.log("inside"); await ctx.db.insert("other", { k: 5 }); throw new Error("undo"); },
  insertSetStack: async (ctx) => { try { await ctx.db.insert("items", { v: new Set([1]) }); } catch (e) { return e.stack; } },
  insertSetUncaught: async (ctx) => { await ctx.db.insert("items", { v: new Set([1]) }); },
  patchFunctionUncaught: async (ctx, a) => { await ctx.db.patch(a, { f: () => 1 }); },
  scheduleSetUncaught: async (ctx) => { await ctx.scheduler.runAfter(0, "cases:m", { v: new Set() }); },
  nestedArgsSetUncaught: async (ctx) => { await ctx.runQuery("cases:q", { c: "empty", a: new Map() }); },
  auditInMutation: async (ctx) => { await log.audit({ m: 1 }); await ctx.runMutation("cases:m", { c: "auditOnly" }); return 1; },
  auditOnly: async () => { await log.audit({ inner: 1 }); return 1; },
}`;

// Under `process`, unawaited operations whose answers come after the handler returned, and leave nothing rejected.
// A rejection nothing handles fails the call there and not under `vm` (DV-528): rejection-parity.test.ts.
const UNAWAITED = `{
  unawaitedHandled: async (ctx) => { const p = ctx.db.get("nope"); await ctx.db.query("items").first(); p.catch(() => {}); return 1; },
  unawaitedThen: async (ctx) => { ctx.db.query("items").first().then(() => console.log("answered after")); return 1; },
}`;

const CASES_MODULE = `
import { query, mutation, createFunctionHandle, log } from ${SERVER};
import { anyApi as api } from ${SERVER};
import { v, BunvexError } from ${VALUES};
const qcases = ${QUERY_CASES};
qcases.otherCount = async (ctx) => (await ctx.db.query("other").collect()).length;
qcases.nowValue = async () => [Date.now()];
Object.assign(qcases, ${UNAWAITED});
const mcases = ${MUTATION_CASES};
export const q = query({ args: { c: v.string(), a: v.optional(v.any()) }, handler: (ctx, { c, a }) => qcases[c](ctx, a) });
export const m = mutation({ args: { c: v.string(), a: v.optional(v.any()), v: v.optional(v.any()) }, handler: (ctx, { c, a }) => mcases[c](ctx, a) });
export const strict = query({ args: { n: v.number() }, returns: v.string(), handler: async (ctx, { n }) => (n > 0 ? "ok" : n) });
export const raw = query(async (ctx, args) => args);
export const QUERY_NAMES = ${"Object.keys(qcases)"};
`;

type Outcome = { status: string; value?: unknown; errorMessage?: string; errorData?: unknown; logLines?: string[] };

/**
 * Ids, creation times, request ids and a console timer's milliseconds: each deployment's own (or its machine's).
 */
const own = (t: string) =>
  t
    .replace(/\b[0-9a-z]{31,37}\b/g, "<id>")
    .replace(/\b1\d{12}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{16}\b/g, "<request>")
    .replace(/: \d+ms\b/g, ": <n>ms");

/** What the client gets, without what differs between two deployments: the request id, ids and times. */
function normalized(o: Outcome) {
  const logLines = JSON.parse(own(JSON.stringify(o.logLines ?? [])));
  if (o.status === "success") return { value: JSON.parse(own(JSON.stringify(o.value ?? null))), logLines };
  const message = (o.errorMessage ?? "")
    .replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "")
    // The frame that constructed the error: JavaScriptCore puts it at the `new` on most runs and at the call's `(`
    // on some, under either executor (seen once in CI, vm at `new Error(`'s paren, process at its `new`).
    .replace(/^(Uncaught [^\n]*\n\s+at [^\n]*:\d+:)\d+\)/, "$1<col>)");
  return { error: own(message), data: o.errorData, logLines };
}

async function deployment(sandbox: "vm" | "process") {
  const schema = defineSchema({
    items: defineTable(v.any())
      .index("by_k", ["k"])
      .index("by_k_s", ["k", "s"])
      .searchIndex("search_s", { searchField: "s" }),
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
  // The log stream's events, as a sink gets them (a stand-in for the sinks, always active).
  const streamed: LogEvent[] = [];
  functions.logManager = { active: true, send: (events: LogEvent[]) => streamed.push(...events) } as never;
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
  return { s, engine, functions, call, firstId, version, streamed };
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

// What the function log (`bunvex logs`, the dashboard) and the log stream (the sinks) get of a call's lines: the same
// structured lines, in the same order, each named by the nested call that wrote it, stamped by the wall clock while
// the call ran.
describe("a call's lines reach the function log and the log stream as under vm", () => {
  type Line = { level: string; messages: string[]; isTruncated: boolean; timestamp: number; subFunction?: unknown };
  let fresh = 0;
  const lines = (l: Line[]) => l.map(({ timestamp: _, ...rest }) => JSON.parse(own(JSON.stringify(rest))));
  const run = async (d: Awaited<ReturnType<typeof deployment>>, kind: "query" | "mutation", c: string, a: unknown) => {
    const cursor = d.functions.functionLog!.headCursor;
    d.streamed.length = 0;
    const before = Date.now();
    await d.call(kind, `cases:${kind === "query" ? "q" : "m"}`, { c, a });
    const after = Date.now();
    const parts = (await d.functions.functionLog!.after(cursor, 0)).parts as {
      kind: string;
      identifier: string;
      logLines: Line[];
    }[];
    const completions = parts.filter((p) => p.kind === "Completion");
    const all = completions.flatMap((p) => p.logLines);
    for (const l of all) {
      expect(l.timestamp).toBeGreaterThanOrEqual(before);
      expect(l.timestamp).toBeLessThanOrEqual(after);
    }
    const console = d.streamed.filter((e) => e.event.topic === "console");
    return {
      log: completions.map((p) => [p.identifier, lines(p.logLines)]),
      stream: console.map((e) =>
        JSON.parse(
          own(
            JSON.stringify({
              ...e,
              timestamp: 0,
              event: { ...e.event, line: lines([(e.event as unknown as { line: Line }).line])[0] },
            }),
          ),
        ),
      ),
      ordered: all.every((l, i) => i === 0 || l.timestamp >= all[i - 1]!.timestamp),
    };
  };
  for (const [kind, c] of [
    ["query", "logLevels"],
    ["query", "logNested"],
    ["query", "logNestedThrows"],
    ["query", "logNestedUncaught"],
    ["query", "logThenThrow"],
    ["query", "logMany"],
    ["query", "logNestedMany"],
    ["query", "logLong"],
    ["query", "logTrace"],
    ["query", "logTimers"],
    ["mutation", "logInMutation"],
    ["mutation", "logNestedMutation"],
    ["mutation", "logNestedRollback"],
  ] as const)
    test(`${kind} ${c}`, async () => {
      // An argument of its own: a result from the query cache would bring back an earlier run's lines and times.
      const a = `fresh ${++fresh}`;
      const x = await run(vm, kind, c, a);
      const y = await run(proc, kind, c, a);
      expect(y).toEqual(x);
      expect(y.ordered).toBe(true);
      expect(y.log.length).toBeGreaterThan(0);
      expect(y.stream.length).toBeGreaterThan(0);
    });

  test("a cached query's lines come back with its result, on a hit too", async () => {
    for (const d of [vm, proc]) {
      const first = await d.call("query", "cases:q", { c: "logLevels", a: "cached" });
      const again = await d.call("query", "cases:q", { c: "logLevels", a: "cached" });
      expect(normalized(again)).toEqual(normalized(first));
      expect(first.logLines!.length).toBe(5);
    }
  });
});

// A module that fails at import (Convex's analysis, at the push): the same error, its message and its frames, mapped
// to the module's source.
describe("an error at import fails the push as under vm", () => {
  const IMPORTS: Record<string, string> = {
    throws: `import { query } from ${SERVER};\nconst f = () => { throw new Error("at import"); };\nf();\nexport const q = query(async () => 1);`,
    typeError: `import { query } from ${SERVER};\nnull.x;\nexport const q = query(async () => 1);`,
    bunvex: `import { BunvexError } from ${VALUES};\nthrow new BunvexError({ at: "import" });`,
    value: `throw "a string at import";`,
    loggedFirst: `console.log("importing");\nthrow new RangeError("after a line");`,
    deep: `const f = (n) => { if (n === 0) throw new Error("deep at import"); return f(n - 1) + 1; };\nf(15);`,
    syntax: `export const q = ;`,
    missing: `import { nope } from "./nowhere.js";\nexport const q = nope;`,
    awaited: `await Promise.reject(new Error("top-level await"));`,
  };
  const pushed = async (d: Awaited<ReturnType<typeof deployment>>, source: string) => {
    try {
      await d.s.deployCode([{ path: "bad.js", source, environment: "isolate" }]);
      return { ok: true };
    } catch (e) {
      return { name: (e as Error).name, message: own((e as Error).message) };
    }
  };
  for (const [name, source] of Object.entries(IMPORTS))
    test(name, async () => {
      const [x, y] = await Promise.all([pushed(vm, source), pushed(proc, source)]);
      expect(y).toEqual(x);
      expect(x.ok).toBeUndefined();
    });
});

// The child answers once the operations the function did not await are answered (STUDY-171 §13): their code runs
// first, as Convex runs a query's syscalls to the end, and logs what it logs into the call.
describe("an operation the function did not await is answered before the call, as under vm", () => {
  for (const c of [...UNAWAITED.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!))
    test(c, async () => {
      const [a, b] = await Promise.all([vm.firstId(), proc.firstId()]);
      const [x, y] = await Promise.all([
        vm.call("query", "cases:q", { c, a }),
        proc.call("query", "cases:q", { c, a: b }),
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
