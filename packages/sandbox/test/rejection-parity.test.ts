// Unhandled rejections (STUDY-171 §13, DV-528): the same pushed code deployed to a server running it in `vm` and to
// one running it in `process`, each case called on both. The one decided difference: under `process` a promise the
// app leaves rejected with no handler, once the microtasks have drained, fails the query, mutation or action with
// that value, as Convex fails it (`environment/udf/mod.rs`, `environment/action/mod.rs`); under `vm` it reaches the
// server process's `unhandledRejection` and the call goes on, its result unchanged (DV-528). The `vm` server runs in a
// process of its own (`fixtures/vm-server.ts`, whose listener reports each one): `bun test` counts a rejection in its
// own process as a failure. What `process` answers is what the same value thrown gives, on both; and the child attributes
// each rejection to its own call when many run at once. `packages/differential`'s `unhandled-rejections.test.ts`
// compares `process` with Convex's binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Cases a query, a mutation and an action share. `fail(value)` leaves `value` rejected with no handler (`mode`
 * "reject"), or throws it ("throw"): the same value, made at the same place, so its frames are the same.
 */
const SHARED = `{
  rejected: async (ctx, fail) => { fail(new Error("never handled")); return 1; },
  rejectedAfterOp: async (ctx, fail, op) => { await op(); fail(new Error("after an operation")); return 1; },
  rejectedBeforeOp: async (ctx, fail, op) => { fail(new Error("before an operation")); await op(); return 1; },
  typeError: async (ctx, fail) => { fail(new TypeError("a type error")); return 1; },
  plainValue: async (ctx, fail) => { fail("a plain string"); return 1; },
  objectValue: async (ctx, fail) => { fail({ a: 1 }); return 1; },
  undefinedValue: async (ctx, fail) => { fail(undefined); return 1; },
}`;

/** Cases with no twin: what each gives under `process` is checked on its own. */
const OWN = `{
  handledInTime: async () => { const p = Promise.reject(new Error("handled")); await null; await null; p.catch(() => {}); return 1; },
  handledAfterOp: async (ctx, a, op) => { const p = Promise.reject(new Error("handled too late")); await op(); p.catch(() => {}); return 1; },
  asyncHelper: async () => { const helper = async () => { await null; throw new Error("from a helper"); }; void helper(); return 1; },
  applicationError: async () => { Promise.reject(new BunvexError({ code: 1 })); return 1; },
  applicationErrorString: async () => { Promise.reject(new BunvexError("with a message")); return 1; },
  nestedRejectionCaught: async (ctx) => { try { await ctx.runQuery("cases:q", { c: "rejected", mode: "reject" }); return "not caught"; } catch (e) { return "caught: " + e.message.split("\\n")[0]; } },
  rejectedThenThrows: async () => { const p = Promise.reject(new Error("rejected first")); await null; p.catch(() => {}); throw new Error("then thrown"); },
}`;

/** Query and mutation cases: an operation they did not await fails after the handler returned. */
const UDF = `{
  unawaitedOp: async (ctx) => { ctx.db.get("nope"); return 1; },
  unawaitedNested: async (ctx) => { ctx.runQuery("cases:q", { c: "throws" }); return 1; },
  unawaitedOpHandledLater: async (ctx) => { const p = ctx.db.get("nope"); await ctx.db.query("items").first(); p.catch(() => {}); return 1; },
  nestedHandledAfterRead: async (ctx) => { const p = ctx.runQuery("cases:q", { c: "throws" }); await ctx.db.query("items").first(); p.catch(() => {}); return 1; },
  throws: async () => { throw new Error("thrown"); },
  slow: async (ctx, a) => { for (let k = 0; k < a.k; k++) await ctx.db.query("items").first(); if (a.fail) Promise.reject(new Error("r" + a.i)); return a.i; },
}`;

const MUTATION = `{
  writes: async (ctx, a) => { await ctx.db.insert("items", { tag: a.tag }); return 1; },
  writesThenRejects: async (ctx, a) => { await ctx.db.insert("items", { tag: a.tag }); Promise.reject(new Error("after a write")); return 1; },
  unawaitedWrite: async (ctx, a) => { await ctx.db.insert("items", { tag: a.tag }); ctx.db.patch("nope", { x: 1 }); return 1; },
}`;

const ACTION = `{
  beforeTimer: async () => { Promise.reject(new Error("before a timer")); await sleep(20); return 1; },
  inTimer: async () => { setTimeout(() => { Promise.reject(new Error("in a timer")); }, 0); await sleep(50); return 1; },
  timerAfterAnswer: async () => { setTimeout(() => { Promise.reject(new Error("after the answer")); }, 0); return 1; },
  stopsTheAction: async (ctx, a) => { Promise.reject(new Error("stops it")); await sleep(20); await ctx.runMutation("cases:m", { c: "writes", a: { tag: a.tag } }); return 1; },
  stopsBeforeOp: async (ctx, a) => { Promise.reject(new Error("stops it at once")); await ctx.runMutation("cases:m", { c: "writes", a: { tag: a.tag } }); return 1; },
  nestedMutationRolledBack: async (ctx, a) => { try { await ctx.runMutation("cases:m", { c: "writesThenRejects", a: { tag: a.tag } }); } catch {} return ctx.runQuery("cases:count", { tag: a.tag }); },
  afterBody: async (ctx, a) => { const r = await fetch(a.url); const text = await r.text(); if (a.fail) Promise.reject(new Error("b" + a.i)); return text.length === 300000 ? a.i : -1; },
  slow: async (ctx, a) => { if (a.fail) setTimeout(() => { Promise.reject(new Error("t" + a.i)); }, a.k); await sleep(a.k + 15); if (a.fail) await sleep(5); return a.i; },
}`;

const CASES_MODULE = `
import { action, query, mutation } from ${SERVER};
import { v, BunvexError } from ${VALUES};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shared = ${SHARED};
const own = ${OWN};
const udf = ${UDF};
const mcases = ${MUTATION};
const acases = ${ACTION};
const fails = { reject: (v) => { Promise.reject(v); }, throw: (v) => { throw v; } };
const args = { c: v.string(), mode: v.optional(v.string()), a: v.optional(v.any()) };
// A case gets \`ctx\`, \`fail\` (or its argument) and \`op\`: an operation of its kind, awaited where it says.
const run = (cases, ctx, op, { c, mode, a }) => cases[c](ctx, mode ? fails[mode] : a, op);
export const q = query({ args, handler: (ctx, x) => run({ ...shared, ...own, ...udf }, ctx, () => ctx.db.query("items").first(), x) });
export const m = mutation({ args, handler: (ctx, x) => run({ ...shared, ...own, ...udf, ...mcases }, ctx, () => ctx.db.query("items").first(), x) });
export const a = action({ args, handler: (ctx, x) => run({ ...shared, ...own, ...acases }, ctx, () => ctx.runQuery("cases:q", { c: "handledInTime" }), x) });
export const count = query({ args: { tag: v.string() }, handler: async (ctx, { tag }) => (await ctx.db.query("items").collect()).filter((d) => d.tag === tag).length });
`;

type Outcome = { status: string; value?: unknown; errorMessage?: string; errorData?: unknown; logLines?: string[] };
type Kind = "query" | "mutation" | "action";

/** What the client gets, without the request id. */
function normalized(o: Outcome) {
  const logLines = o.logLines ?? [];
  if (o.status === "success") return { value: o.value ?? null, logLines };
  const error = (o.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "");
  return { error, data: o.errorData, logLines };
}

/** The error's first line: its value, as `Uncaught …` gives it. */
const header = (o: Outcome) => normalized(o).error?.split("\n")[0];

/** What reached the `vm` server's `unhandledRejection` (DV-528), in order. */
const reachedTheServer: string[] = [];

const pathOf = { query: "cases:q", mutation: "cases:m", action: "cases:a" } as const;
const caller = (port: number) => {
  const call = async (kind: Kind, path: string, args: object): Promise<Outcome> =>
    (await (
      await fetch(`http://127.0.0.1:${port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as Outcome;
  const run = (kind: Kind, c: string, extra: object = {}) => call(kind, pathOf[kind], { c, ...extra });
  return { call, run };
};

/** The `vm` server, in a process of its own: its port, and each rejection it heard. */
async function vmDeployment() {
  const dir = mkdtempSync(join(tmpdir(), "rejection-parity-"));
  writeFileSync(join(dir, "cases.js"), CASES_MODULE);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/vm-server.ts"), join(dir, "cases.js")], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const port = await new Promise<number>((resolve, reject) => {
    void (async () => {
      let buffered = "";
      for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
        buffered += chunk;
        let nl = buffered.indexOf("\n");
        while (nl >= 0) {
          const line = JSON.parse(buffered.slice(0, nl)) as { port?: number; rejection?: string };
          buffered = buffered.slice(nl + 1);
          if (line.port !== undefined) resolve(line.port);
          if (line.rejection !== undefined) reachedTheServer.push(line.rejection);
          nl = buffered.indexOf("\n");
        }
      }
      reject(new Error("the vm server ended"));
    })();
  });
  const stop = async () => {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  };
  return { ...caller(port), stop };
}

/** The `process` server, in this process (its rejections are its child's). */
async function processDeployment() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: "process",
    functionSandboxIsolation: "none",
  });
  await s.codeReady;
  await engine.mutation(async (db) => {
    await db.insert("items", { k: 1 });
  });
  await s.deployCode([{ path: "cases.js", source: CASES_MODULE, environment: "isolate" }]);
  return { ...caller(s.server.port!), stop: () => s.shutdown() };
}

let vm: Awaited<ReturnType<typeof vmDeployment>>;
let proc: Awaited<ReturnType<typeof processDeployment>>;
/** What the actions' `fetch` reads: a body of 300 000 bytes, after a while, so the calls' bodies interleave. */
let target: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      await Bun.sleep(Math.random() * 20);
      return new Response("x".repeat(300_000));
    },
  });
  [vm, proc] = await Promise.all([vmDeployment(), processDeployment()]);
}, 30_000);
afterAll(async () => {
  await vm?.stop();
  await proc?.stop();
  target?.stop(true);
});

/** Until the `vm` server's report of `n` rejections in all has come (its line comes after the call's answer). */
async function heard(n: number) {
  for (let i = 0; i < 100 && reachedTheServer.length < n; i++) await Bun.sleep(10);
  return reachedTheServer.length;
}

const names = (cases: string) => [...cases.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
const KINDS: Kind[] = ["query", "mutation", "action"];

describe("process fails the call with the value, as thrown; vm logs it and goes on (DV-528)", () => {
  for (const kind of KINDS)
    for (const c of names(SHARED))
      test(`${kind} ${c}`, async () => {
        const before = reachedTheServer.length;
        const [x, y, thrown] = await Promise.all([
          vm.run(kind, c, { mode: "reject" }),
          proc.run(kind, c, { mode: "reject" }),
          vm.run(kind, c, { mode: "throw" }),
        ]);
        // vm: the call's result unchanged, the rejection at the server's listener.
        expect(normalized(x)).toEqual({ value: 1, logLines: [] });
        expect(await heard(before + 1)).toBe(before + 1);
        // process: what the same value thrown gives, its frames included. An action failed while its operation was in
        // flight has left it unawaited, and says so, as Convex's (packages/differential).
        const unawaited =
          kind === "action" && c === "rejectedBeforeOp"
            ? ["[WARN] 1 unawaited operation: [query]. Async operations should be awaited or they might not run."]
            : [];
        expect(normalized(y)).toEqual({ ...normalized(thrown), logLines: unawaited });
        expect(y.status).toBe("error");
      });
});

/** What `process` answers for each case with no twin: Convex's (`packages/differential` checks it there). */
const PROCESS: Record<string, (kind: Kind) => { header?: string; value?: unknown }> = {
  handledInTime: () => ({ value: 1 }),
  handledAfterOp: () => ({ header: "Uncaught Error: handled too late" }),
  asyncHelper: () => ({ header: "Uncaught Error: from a helper" }),
  applicationError: () => ({ header: 'Uncaught BunvexError: {"code":1}' }),
  applicationErrorString: () => ({ header: "Uncaught BunvexError: with a message" }),
  nestedRejectionCaught: () => ({ value: "caught: Uncaught Error: never handled" }),
  rejectedThenThrows: () => ({ header: "Uncaught Error: then thrown" }),
  unawaitedOp: () => ({
    header: "Uncaught Error: Invalid argument `id` for `db.get`: Unable to decode ID: Invalid ID length 4",
  }),
  unawaitedNested: () => ({ header: "Uncaught Error: thrown" }),
  // Reads answered in one batch, as Convex's: the rejection is handled in time.
  unawaitedOpHandledLater: () => ({ value: 1 }),
  // A nested call is a batch of its own: its rejection is checked before the read is answered.
  nestedHandledAfterRead: () => ({ header: "Uncaught Error: thrown" }),
  writes: () => ({ value: 1 }),
  writesThenRejects: () => ({ header: "Uncaught Error: after a write" }),
  unawaitedWrite: () => ({
    header: "Uncaught Error: Invalid argument `id` for `db.patch`: Unable to decode ID: Invalid ID length 4",
  }),
  beforeTimer: () => ({ header: "Uncaught Error: before a timer" }),
  inTimer: () => ({ header: "Uncaught Error: in a timer" }),
  timerAfterAnswer: () => ({ value: 1 }),
  stopsTheAction: () => ({ header: "Uncaught Error: stops it" }),
  stopsBeforeOp: () => ({ header: "Uncaught Error: stops it at once" }),
  nestedMutationRolledBack: () => ({ value: 0 }),
};
/** What `vm` answers where it is not the call's own result: a nested call's rejection is not caught there either. */
const VM: Record<string, unknown> = { nestedRejectionCaught: "not caught", nestedMutationRolledBack: 1 };

describe("each case on its own", () => {
  const cases: [Kind, string][] = [
    ...KINDS.flatMap((k) => names(OWN).map((c) => [k, c] as [Kind, string])),
    ...(["query", "mutation"] as const).flatMap((k) =>
      names(UDF)
        .filter((c) => c !== "throws" && c !== "slow")
        .map((c) => [k, c] as [Kind, string]),
    ),
    ...names(MUTATION).map((c) => ["mutation", c] as [Kind, string]),
    ...names(ACTION)
      .filter((c) => c !== "slow" && c !== "afterBody")
      .map((c) => ["action", c] as [Kind, string]),
  ];
  for (const [kind, c] of cases)
    test(`${kind} ${c}`, async () => {
      const tag = `${kind}-${c}-${Math.random()}`;
      const [x, y] = await Promise.all([vm.run(kind, c, { a: { tag } }), proc.run(kind, c, { a: { tag } })]);
      const want = PROCESS[c]!(kind);
      if (want.header !== undefined) {
        expect({ status: y.status, header: header(y), data: y.errorData }).toEqual({
          status: "error",
          header: want.header,
          data: undefined,
        });
        // vm: the call goes on (DV-528), unless the error was its own.
        if (c === "rejectedThenThrows") expect(header(x)).toBe(want.header);
        else expect(normalized(x).value).toBe(1);
      } else {
        expect(normalized(y).value).toEqual(want.value);
        expect(normalized(x).value).toEqual(c in VM ? VM[c] : want.value);
      }
    });

  test("a mutation's writes are rolled back with it under process, kept under vm", async () => {
    const tag = `rolled-${Math.random()}`;
    await Promise.all([vm, proc].map((d) => d.run("mutation", "writesThenRejects", { a: { tag } })));
    const [x, y] = await Promise.all([vm, proc].map((d) => d.call("query", "cases:count", { tag })));
    expect([x!.value, y!.value]).toEqual([1, 0]);
  });

  test("an action stops where it failed: what it would have done after never runs", async () => {
    const tag = `stops-${Math.random()}`;
    await proc.run("action", "stopsTheAction", { a: { tag } });
    await Bun.sleep(100);
    expect((await proc.call("query", "cases:count", { tag })).value).toBe(0);
  });

  test("an operation started in the turn of the rejection is left unawaited, as on Convex", async () => {
    const o = await proc.run("action", "stopsBeforeOp", { a: { tag: `before-${Math.random()}` } });
    expect(o.logLines).toEqual([
      "[WARN] 1 unawaited operation: [mutation]. Async operations should be awaited or they might not run.",
    ]);
  });
});

describe("each rejection fails its own call when many run at once in the child", () => {
  const many = async (kind: Kind, n: number, c = "slow") => {
    const url = `http://127.0.0.1:${target.port}/`;
    const outcomes = await Promise.all(
      Array.from({ length: n }, (_, i) => proc.run(kind, c, { a: { i, k: (i * 7) % 5, fail: i % 3 === 0, url } })),
    );
    const prefix = c === "afterBody" ? "b" : kind === "action" ? "t" : "r";
    return outcomes.map((o, i) =>
      i % 3 === 0 ? expect(header(o)).toBe(`Uncaught Error: ${prefix}${i}`) : expect(o.value).toBe(i),
    );
  };
  test("queries", () => many("query", 30));
  test("mutations", () => many("mutation", 30));
  test("actions, each failing in its own timer", () => many("action", 30));
  test("actions, each failing once its fetch's body is read", () => many("action", 20, "afterBody"));
  test("all three at once", () => Promise.all([many("query", 20), many("mutation", 20), many("action", 20)]));
  test("the child still serves", async () => {
    expect(normalized(await proc.run("query", "handledInTime"))).toEqual({ value: 1, logLines: [] });
  });
});
