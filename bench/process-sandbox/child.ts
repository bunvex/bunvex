// STUDY-168 prototype: the sandboxed executor. One Bun process per deployment runs the app's functions; every
// `ctx` call (`db.get`, a query page, an insert, the scheduler, a nested call, `fetch`) is an op sent to the host,
// which runs it in the real transaction. The child holds no data, no credentials and no transaction state: read
// sets, OCC, commit and the query cache stay on the host.
//
// Started by host.ts as `bun child.ts` (inside bubblewrap on Linux), with APP = the app module to load and
// VALUES = the `bunvex/values` entry. Messages are those of wire.ts over Bun's IPC channel.
import { AsyncLocalStorage } from "node:async_hooks";
import { decode, encode, recorder, type ToChild, type ToHost, type Wire } from "./wire.ts";

type Def = { kind: "query" | "mutation" | "action"; handler: (ctx: unknown, args: unknown) => unknown };
type Execution = { call: number; kind: Def["kind"]; now: number; random: () => number; env: Record<string, string> };

const started = performance.now();
const send = (m: ToHost) => process.send?.(m);
const executions = new AsyncLocalStorage<Execution>();

// --- The app's view of `bunvex/server`: the builders only (validation runs on the host). ---
const builder =
  (kind: Def["kind"]) =>
  (def: Def["handler"] | { handler: Def["handler"] }): Def => ({
    kind,
    handler: typeof def === "function" ? def : def.handler,
  });
const values = await import(process.env.VALUES as string);
Bun.plugin({
  name: "bunvex-sandbox",
  setup(build) {
    build.module("bunvex/server", () => ({
      loader: "object",
      exports: {
        query: builder("query"),
        internalQuery: builder("query"),
        mutation: builder("mutation"),
        internalMutation: builder("mutation"),
        action: builder("action"),
        internalAction: builder("action"),
      },
    }));
    build.module("bunvex/values", () => ({ loader: "object", exports: values }));
  },
});

// --- Determinism (queries and mutations): time frozen and `Math.random` seeded per execution. ---
const realNow = Date.now;
const realRandom = Math.random;
const RealDate = Date;
Date.now = () => executions.getStore()?.now ?? realNow();
Math.random = () => executions.getStore()?.random() ?? realRandom();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args) {
    const e = executions.getStore();
    return args.length === 0 && e ? new target(e.now) : new target(...(args as []));
  },
}) as DateConstructor;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Ops: each one a round trip to the host, answered in order of its id. ---
let nextOp = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
function op(name: string, ...args: unknown[]): Promise<unknown> {
  const e = executions.getStore();
  if (!e) return Promise.reject(new Error(`${name} called outside a function`));
  const id = ++nextOp;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: "op", call: e.call, op: id, name, args: args.map(encode) });
  });
}

/** `db.query(table)`: the chain is recorded, and sent as one op when a terminal method runs. */
function queryProxy(table: string, system: boolean, steps: [string, Wire[]][] = []): unknown {
  const plan = (terminal: string, ...a: unknown[]) =>
    op("query", { table, system, steps: steps as unknown as Wire, terminal, args: a.map(encode) });
  const next = (s: [string, Wire[]]) => queryProxy(table, system, [...steps, s]);
  return {
    withIndex: (name: string, range?: (q: unknown) => unknown) =>
      next(["withIndex", [name, range ? encode(range(recorder())) : null]]),
    withSearchIndex: (name: string, f: (q: unknown) => unknown) =>
      next(["withSearchIndex", [name, encode(f(recorder()))]]),
    fullTableScan: () => next(["fullTableScan", []]),
    order: (dir: string) => next(["order", [dir]]),
    filter: (f: (q: unknown) => unknown) => next(["filter", [encode(f(recorder()))]]),
    limit: (n: number) => next(["limit", [n]]),
    take: (n: number) => plan("take", n),
    first: () => plan("first"),
    unique: () => plan("unique"),
    collect: () => plan("collect"),
    count: () => plan("count"),
    paginate: (opts: unknown) => plan("paginate", opts),
    // A prototype: iterating collects first (bunvex and Convex stream page by page).
    async *[Symbol.asyncIterator]() {
      for (const d of (await plan("collect")) as unknown[]) yield d;
    },
  };
}

const reader = (system: boolean) => ({
  get: (a: string, b?: string) => op(system ? "system.get" : "get", a, b),
  query: (table: string) => queryProxy(table, system),
});

function makeCtx(kind: Def["kind"]) {
  const runQuery = (fn: unknown, args?: unknown) => op("runQuery", fn, args ?? {});
  const runMutation = (fn: unknown, args?: unknown) => op("runMutation", fn, args ?? {});
  const scheduler = {
    runAfter: (ms: number, fn: unknown, args?: unknown) => op("scheduler.runAfter", ms, fn, args ?? {}),
    runAt: (ts: number, fn: unknown, args?: unknown) => op("scheduler.runAt", ts, fn, args ?? {}),
    cancel: (id: string) => op("scheduler.cancel", id),
  };
  const auth = { getUserIdentity: () => op("auth.getUserIdentity") };
  if (kind === "action")
    return {
      auth,
      scheduler,
      runQuery,
      runMutation,
      runAction: (fn: unknown, a?: unknown) => op("runAction", fn, a ?? {}),
    };
  const db = {
    ...reader(false),
    system: reader(true),
    normalizeId: (table: string, id: string) => op("normalizeId", table, id),
    insert: (table: string, doc: unknown) => op("insert", table, doc),
    patch: (a: string, b: unknown, c?: unknown) => op("patch", a, b, c),
    replace: (a: string, b: unknown, c?: unknown) => op("replace", a, b, c),
    delete: (a: string, b?: string) => op("delete", a, b),
  };
  if (kind === "query")
    return { db: { ...reader(false), system: reader(true), normalizeId: db.normalizeId }, auth, runQuery };
  return { db, auth, scheduler, runQuery, runMutation };
}

// `fetch` in an action goes through the host (its SSRF screen); the sandbox has no network of its own.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const r = (await op("fetch", url, {
    method: init?.method ?? "GET",
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: typeof init?.body === "string" ? init.body : null,
  })) as { status: number; headers: Record<string, string>; body: string };
  return new Response(r.body, { status: r.status, headers: r.headers });
}) as typeof fetch;

// Logs are the call's log lines, sent to the host (which owns the function log).
for (const level of ["log", "info", "warn", "error", "debug"] as const)
  console[level] = (...a: unknown[]) =>
    send({ t: "log", call: executions.getStore()?.call ?? 0, level, text: a.map((x) => String(x)).join(" ") });

// --- Load the app (Convex's analyze: the function list goes to the host, which registers its stand-ins). ---
// The module's exports are its functions, as a bunvex module's: `export const list = query(…)` is `<module>:list`.
const appPath = process.env.APP as string;
const moduleName = appPath.slice(appPath.lastIndexOf("/") + 1).replace(/\.[jt]s$/, "");
const mod = (await import(appPath)) as Record<string, Def>;
const defs = new Map<string, Def>();
for (const [name, def] of Object.entries(mod))
  if (def && typeof def.handler === "function") defs.set(`${moduleName}:${name}`, def);

process.on("message", (raw) => {
  const m = raw as ToChild;
  if (m.t === "result") {
    const p = pending.get(m.op);
    if (!p) return;
    pending.delete(m.op);
    if (m.ok) p.resolve(decode(m.value));
    else p.reject(Object.assign(new Error(m.error.message), { name: m.error.name, data: m.error.data }));
    return;
  }
  if (m.t === "call") void run(m);
});

async function run(m: Extract<ToChild, { t: "call" }>) {
  const def = defs.get(m.fn);
  const e: Execution = { call: m.call, kind: m.kind, now: m.now, random: mulberry32(m.seed), env: m.env };
  try {
    if (!def) throw new Error(`Could not find function for '${m.fn}'`);
    const value = await executions.run(e, () => def.handler(makeCtx(def.kind), decode(m.args)));
    send({ t: "done", call: m.call, ok: true, value: encode(value) });
  } catch (err) {
    const x = err as { name?: string; message?: string; data?: unknown; stack?: string };
    send({
      t: "done",
      call: m.call,
      ok: false,
      error: { name: x?.name ?? "Error", message: String(x?.message ?? err), data: encode(x?.data), stack: x?.stack },
    });
  }
}

// `process.env` is the deployment's variables of the running execution (the sandbox's own environment is empty).
const realEnv = process.env;
Object.defineProperty(process, "env", {
  get: () => executions.getStore()?.env ?? {},
  configurable: true,
});
void realEnv;

send({
  t: "ready",
  functions: Object.fromEntries([...defs].map(([k, d]) => [k, d.kind])),
  loadMs: performance.now() - started,
});
