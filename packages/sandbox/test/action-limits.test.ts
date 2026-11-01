// An action's limits and checks over the bridge (STUDY-171 §12): past its timeout an action fails with Convex's
// message and is cut off from its `ctx` and its `fetch`, as under `vm`; in its child the handler is told so, and a
// child that cannot hear it (JavaScript that never yields) is killed, where `vm` would run that loop forever. Its
// lines reach the function log as they come, as under `vm`. A child that forges what an action may not send is
// killed.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor, ProcessExecutor } from "../src/executor.ts";
import { CUT_OFF_GRACE_MS } from "../src/host-action.ts";

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const MODULE = `
import { action, query, mutation } from ${SERVER};
let counted = 0;
// Its argument keeps the query cache out: each call runs.
export const count = query(async (ctx, { i }) => ++counted);
export const read = query(async (ctx) => (await ctx.db.query("items").collect()).length);
export const ins = mutation(async (ctx) => ctx.db.insert("items", {}));
export const who = action(async (ctx) => ctx.auth.getUserIdentity());
export const forever = action(async () => { for (;;) {} });
export const spinsAwaiting = action(async () => { for (;;) await null; });
export const slowFetch = action(async (ctx, { url }) => { try { await fetch(url); } catch (e) { console.log("fetch failed", e.name); throw e; } });
export const writesLate = action(async (ctx) => {
  console.log("before the timeout");
  await new Promise((r) => setTimeout(r, 400));
  console.log("after the timeout");
  try { await ctx.runMutation("m:ins", {}); } catch (e) { console.log("refused", e.message); }
  try { await ctx.storage.store(new Blob(["x"])); } catch (e) { console.log("refused", e.message); }
});
export const lingers = action(async () => { setInterval(() => {}, 50); await new Promise(() => {}); });
export const streams = action(async () => {
  console.log("first");
  await new Promise((r) => setTimeout(r, 60));
  console.log("second", { n: 2 });
  await new Promise((r) => setTimeout(r, 60));
  console.warn("third");
  return 3;
});
export const nestedLines = action(async (ctx) => {
  console.log("outer before");
  await ctx.runAction("m:streams", {});
  console.log("outer after");
  return 1;
});
`;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  provideProcessExecutor(createProcessExecutor);
});
provideProcessExecutor(createProcessExecutor);

const INTERNAL = { code: "InternalServerError", message: "Your request couldn't be completed. Try again later." };
const firstLine = (m: string | undefined) =>
  (m ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "").split("\n")[0];

type Outcome = { status?: string; value?: unknown; errorMessage?: string; logLines?: string[] } & Record<
  string,
  unknown
>;

async function deployment(sandbox: "vm" | "process", actionTimeoutMs?: number) {
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
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
    fileStorage: null,
  });
  stops.push(() => s.shutdown());
  if (actionTimeoutMs !== undefined) functions.actionTimeoutMs = actionTimeoutMs;
  await s.codeReady;
  await s.deployCode([{ path: "m.js", source: MODULE, environment: "isolate" }]);
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as Outcome;
  const items = () => engine.query(async (db) => (await db.query("items").collect()).length);
  return { engine, functions, call, items };
}

describe("the action's timeout, then the cut-off", () => {
  test("a fetch in flight is aborted, and the action fails with Convex's message, as under vm", async () => {
    const slow = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Bun.sleep(3000).then(() => new Response("late")),
    });
    stops.push(() => slow.stop(true));
    const url = `http://127.0.0.1:${slow.port}/`;
    const [x, y] = await Promise.all(
      (["vm", "process"] as const).map(async (mode) => {
        const d = await deployment(mode, 300);
        const started = performance.now();
        const r = await d.call("action", "m:slowFetch", { url });
        return { error: firstLine(r.errorMessage), fast: performance.now() - started < 2000, lines: r.logLines };
      }),
    );
    expect(y).toEqual(x);
    expect(x!.error).toBe("Function execution timed out (maximum duration: 300ms)");
    expect(x!.fast).toBe(true);
  });

  test("what the action calls after its timeout is refused, and its lines are not logged, as under vm", async () => {
    const [x, y] = await Promise.all(
      (["vm", "process"] as const).map(async (mode) => {
        const d = await deployment(mode, 200);
        const r = await d.call("action", "m:writesLate");
        await Bun.sleep(700);
        return { error: firstLine(r.errorMessage), lines: r.logLines, items: await d.items() };
      }),
    );
    expect(y).toEqual(x);
    expect(x).toEqual({
      error: "Function execution timed out (maximum duration: 200ms)",
      lines: ["[LOG] 'before the timeout'"],
      items: 0,
    });
  });

  test("an action whose JavaScript never yields is stopped: its child is killed, and the next call gets a new one", async () => {
    // Under `vm` such an action blocks the server for good: there is nothing to compare.
    const d = await deployment("process", 200);
    // The waiting query's own budget is not what stops the child here.
    d.functions.userTimeoutMs = 10_000;
    const started = performance.now();
    const [stuck, waiting] = await Promise.all([
      d.call("action", "m:forever"),
      // Sent once the loop runs: its child cannot answer until it is killed.
      Bun.sleep(50).then(() => d.call("query", "m:count", { i: 1 })),
    ]);
    expect(firstLine(stuck.errorMessage)).toBe("Function execution timed out (maximum duration: 200ms)");
    expect(waiting).toEqual(INTERNAL);
    // The timeout, the grace, the kill: never forever.
    expect(performance.now() - started).toBeLessThan(200 + CUT_OFF_GRACE_MS + 1500);
    expect(await d.call("query", "m:count", { i: 2 })).toMatchObject({ status: "success", value: 1 });
  });

  test("an action that awaits in a loop that never ends is stopped too (its child never reads the cut-off)", async () => {
    const d = await deployment("process", 200);
    expect(firstLine((await d.call("action", "m:spinsAwaiting")).errorMessage)).toContain("timed out");
    await Bun.sleep(CUT_OFF_GRACE_MS + 300);
    expect(await d.call("query", "m:count", { i: 3 })).toMatchObject({ status: "success", value: 1 });
  });

  test("an action that heard its cut-off keeps its child: the version's other calls go on", async () => {
    const d = await deployment("process", 200);
    expect(await d.call("query", "m:count", { i: 4 })).toMatchObject({ value: 1 });
    expect(firstLine((await d.call("action", "m:lingers")).errorMessage)).toContain("timed out");
    await Bun.sleep(CUT_OFF_GRACE_MS + 300);
    // The same child: its module state goes on.
    expect(await d.call("query", "m:count", { i: 5 })).toMatchObject({ value: 2 });
  });
});

describe("an action's lines reach the function log as they come, as under vm", () => {
  type Part = { kind: string; identifier?: string; logLines: { level: string; messages: string[] }[] };
  const run = async (mode: "vm" | "process", path: string) => {
    const d = await deployment(mode);
    const log = d.functions.functionLog!;
    const cursor = log.headCursor;
    const seen: { kind: string; lines: string[] }[] = [];
    const append = log.append.bind(log);
    log.append = ((entry: Part) => {
      seen.push({ kind: entry.kind, lines: entry.logLines.map((l) => `${l.level} ${l.messages.join(" ")}`) });
      return append(entry as never);
    }) as typeof log.append;
    const r = await d.call("action", path);
    const parts = ((await log.after(cursor, 0)).parts as Part[]).map((p) => ({
      kind: p.kind,
      identifier: p.identifier,
      lines: p.logLines.map((l) => `${l.level} ${l.messages.join(" ")}`),
    }));
    return { value: r.value, lines: r.logLines, parts, seen };
  };
  for (const path of ["m:streams", "m:nestedLines"])
    test(path, async () => {
      const [x, y] = await Promise.all([run("vm", path), run("process", path)]);
      expect(y).toEqual(x);
      // Each line as it came: a Progress event of its own before the Completion.
      expect(x.parts.filter((p) => p.kind === "Progress").length).toBeGreaterThanOrEqual(3);
    });
});

describe("a child that forges an action's messages is killed", () => {
  const forging = async (mode: string) => {
    const entry = join(import.meta.dir, `fixtures/children/forge-${mode}.ts`);
    provideProcessExecutor(() => new ProcessExecutor({ entry }));
    return deployment("process");
  };
  for (const mode of ["insert", "unknownOp", "chunk", "cancelled", "fileSize", "fetchNoInput", "badTag", "tooManyArgs"])
    test(mode, async () => {
      const d = await forging(mode);
      expect(await d.call("action", "m:who")).toEqual(INTERNAL);
      expect(await d.items()).toBe(0);
      // The next call gets a new child.
      expect(await d.call("query", "m:read")).toMatchObject({ status: "success", value: 0 });
    });
});

describe("a child that dies under an action", () => {
  test("fails it as an internal error, and the next call gets a new child", async () => {
    const d = await deployment("process");
    const killer = Bun.sleep(100).then(async () => {
      // The version's child is the only one this test's server started that runs functions (the push's evaluator
      // started first): the newest of this process's `bun` children.
      const ps = Bun.spawnSync(["pgrep", "-P", String(process.pid), "-n"])
        .stdout.toString()
        .trim();
      process.kill(Number(ps), "SIGKILL");
    });
    const [r] = await Promise.all([d.call("action", "m:lingers"), killer]);
    expect(r).toEqual(INTERNAL);
    expect(await d.call("query", "m:count", { i: 6 })).toMatchObject({ status: "success", value: 1 });
  });
});
