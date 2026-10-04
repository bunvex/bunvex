// `log.audit` and `log.vars` (STUDY-82), as Convex's `log` export: the body's checks, the lines of a query
// or mutation (nested calls included) resolved with the request's variables and sent as `custom_audit` events,
// Convex's limits, actions refused, and subscribe-all sinks leaving the topic out.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { log } from "../src/log.ts";
import type { LogEvent } from "../src/log-events.ts";
import { passes } from "../src/log-sink-http.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
const env: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const k of env.splice(0)) delete process.env[k];
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    viewed: query(async (_ctx, { id }: { id: string }) => {
      await log.audit({
        action: "document.viewed",
        actor: { userId: id },
        source: { ip: log.vars.ip, userAgent: log.vars.userAgent, requestId: log.vars.requestId },
        timestamp: log.vars.now,
        admin: log.vars.bunvexActor,
        list: [1, log.vars.ip],
      });
      return "ok";
    }),
    written: mutation(async ({ db, runQuery }) => {
      await db.insert("items", {});
      await log.audit({ action: "document.written" });
      await runQuery("m:viewed" as never, { id: "nested" } as never);
      return "ok";
    }),
    dollar: query(async () => {
      try {
        await log.audit({ ok: { $bad: 1 } });
      } catch (e) {
        return (e as Error).message;
      }
    }),
    unknownVar: query(async () => {
      try {
        await log.audit({ v: Symbol("var.mine") as never });
      } catch (e) {
        return (e as Error).message;
      }
    }),
    inAction: action(async () => {
      try {
        await log.audit({ action: "x" });
      } catch (e) {
        return (e as Error).message;
      }
    }),
    many: query(async (_ctx, { n, size }: { n: number; size: number }) => {
      for (let i = 0; i < n; i++) await log.audit({ i, text: "x".repeat(size), at: log.vars.now });
      return "ok";
    }),
    failing: query(async () => {
      await log.audit({ action: "attempted" });
      throw new Error("then failed");
    }),
    heap: query(async () => {
      try {
        for (let i = 0; i < 100; i++) await log.audit({ text: "y".repeat(600) });
      } catch (e) {
        return (e as Error).message;
      }
    }),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  // A sink that would take `custom_audit` (none can subscribe on a self-hosted deployment): what is sent.
  const sent: LogEvent[] = [];
  functions.logManager = { active: true, send: (events: LogEvent[]) => sent.push(...events) } as never;
  const call = async (kind: string, path: string, args: object = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "audit-test/1.0", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ path, args }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const audits = () =>
    sent.filter((e) => e.event.topic === "custom_audit").map((e) => (e.event as { body: unknown }).body);
  return { functions, call, audits };
}

test("a query's line, its variables resolved from the request, sent as a custom_audit event", async () => {
  const t = await setup();
  const before = Date.now();
  const r = await t.call("query", "m:viewed", { id: "u1" });
  expect(r.body.value).toBe("ok");
  const [body] = t.audits() as Record<string, unknown>[];
  expect(body).toMatchObject({
    action: "document.viewed",
    actor: { userId: "u1" },
    source: { ip: "203.0.113.7", userAgent: "audit-test/1.0" },
    admin: null,
    list: [1, "203.0.113.7"],
  });
  expect((body!.source as { requestId: string }).requestId).toMatch(/^[0-9a-f]{16}$/);
  expect(body!.timestamp as number).toBeGreaterThanOrEqual(before);
});

test("a mutation's lines and its nested query's, in order, once", async () => {
  const t = await setup();
  expect((await t.call("mutation", "m:written")).body.value).toBe("ok");
  expect(t.audits().map((b) => (b as { action: string }).action)).toEqual(["document.written", "document.viewed"]);
});

test("a run that fails still sends its lines, as Convex's runner resolves them whatever the result", async () => {
  const t = await setup();
  expect((await t.call("query", "m:failing")).body.status).toBe("error");
  expect(t.audits()).toEqual([{ action: "attempted" }]);
});

test("Convex's checks: keys starting with $, unknown variables, actions", async () => {
  const t = await setup();
  expect((await t.call("query", "m:dollar")).body.value).toBe('Audit log body keys must not start with "$": "$bad"');
  expect((await t.call("query", "m:unknownVar")).body.value).toBe("Unknown audit var symbol: Symbol(var.mine).");
  expect((await t.call("action", "m:inAction")).body.value).toBe("Audit logging is not yet supported in actions");
  expect(t.audits()).toEqual([]);
});

test("Convex's limits: lines, a line's maximum size, the total, the heap", async () => {
  const t = await setup();
  for (const [k, value] of [
    ["AUDIT_LOG_MAX_LINES", "3"],
    ["AUDIT_LOG_MAX_LINE_SIZE_BYTES", "2000"],
    ["AUDIT_LOG_MAX_TOTAL_SIZE_BYTES", "5000"],
  ] as const) {
    process.env[k] = value;
    env.push(k);
  }
  expect((await t.call("query", "m:many", { n: 3, size: 10 })).body.value).toBe("ok");
  expect(await t.call("query", "m:many", { n: 4, size: 10 })).toEqual({
    status: 400,
    body: { code: "TooManyAuditLogLines", message: "Function execution exceeded the maximum of 3 audit log lines." },
  });
  // Each variable counts at its longest (1026 bytes): a 1000-byte line with one is over 2000.
  const line = await t.call("query", "m:many", { n: 1, size: 1000 });
  expect(line.status).toBe(400);
  expect(line.body.code).toBe("AuditLogLineTooLarge");
  expect(line.body.message).toMatch(
    /^An audit log line may have a maximum possible size of 2000 bytes, but this line could be up to \d+ bytes\.$/,
  );
  const total = await t.call("query", "m:many", { n: 3, size: 700 });
  expect(total.body.code).toBe("AuditLogLinesTooLarge");
  expect(total.body.message).toMatch(
    /^The total maximum possible size of audit log lines from a single function execution is 5000 bytes, but this execution could produce up to \d+ bytes\.$/,
  );
  // The lines a function holds are bounded as it adds them: a catchable error.
  process.env.AUDIT_LOG_MAX_HEAP_SIZE_BYTES = "1000";
  env.push("AUDIT_LOG_MAX_HEAP_SIZE_BYTES");
  expect((await t.call("query", "m:heap")).body.value).toBe("Audit logs exceed function execution limits");
});

test("a sink subscribed to every topic leaves custom_audit out; one that names it gets it", () => {
  const e: LogEvent = { timestamp: 1, event: { topic: "custom_audit", body: {} } };
  expect(passes(undefined, e)).toBe(false);
  expect(passes(["custom_audit"], e)).toBe(true);
  expect(passes(undefined, { timestamp: 1, event: { topic: "audit_log", action: "a", metadata: {} } })).toBe(true);
});
