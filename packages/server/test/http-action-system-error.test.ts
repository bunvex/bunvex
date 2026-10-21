// A system error in an HTTP action (STUDY-171 §14.6 Q-PR6-3): the server's failure, not the app's, answers Convex's
// internal error — `{code: "InternalServerError", message: "Your request couldn't be completed. Try again later."}`,
// 500 (503 out of retention; an index not ready its own 503) — never the error's own message; the run is logged
// under the request with that fixed message, and the detail goes to the server's log only. The app's own throw keeps
// its 500 with the message and the trace. Under `vm` (the default executor): the failures the function sandbox's
// host raises (`ExecutorFailure`) are thrown by the handler here, as they reach the server from it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { defineSchema, defineTable, Engine, IndexesUnavailableError, OutOfRetentionError } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { ExecutorFailure } from "../src/errors.ts";
import type { Part } from "../src/function-log.ts";
import { Functions, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const SECRET = "6e".repeat(32);
const NAME = "system-error-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 1 });
const INTERNAL = { code: "InternalServerError", message: "Your request couldn't be completed. Try again later." };
const DETAIL = "the function sandbox's process sent a message that is not valid: forged";

// biome-ignore lint/suspicious/noExplicitAny: the handler's ctx
const failures: Record<string, (ctx: any) => Promise<unknown>> = {
  // What the `process` executor's host throws when its child breaks the protocol or dies.
  executor: async () => {
    throw new ExecutorFailure(DETAIL);
  },
  // A system error the engine raises under a nested call: a page of `limit(0)` has no cursor (Convex's "Cursor was
  // None"), which fails the run wherever it is caught (DV-209).
  page: (ctx) => ctx.runQuery("m:emptyPage", {}),
  retention: async () => {
    throw new OutOfRetentionError(1n, 2n);
  },
  indexes: async () => {
    throw new IndexesUnavailableError("SearchIndexesUnavailable", "Search indexes are not ready yet");
  },
  thrown: async () => {
    throw new Error("the app's own");
  },
};

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const http = httpRouter();
  http.route({
    pathPrefix: "/fail/",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const kind = new URL(req.url).pathname.slice("/fail/".length);
      console.log("failing", kind);
      await failures[kind]!(ctx);
      return new Response("unreachable");
    }),
  });
  const functions = new Functions(engine).register("m", {
    emptyPage: query(async ({ db }) => {
      // biome-ignore lint/suspicious/noExplicitAny: `limit` is the engine's, not in the query's type
      await (db.query("items") as any).limit(0).paginate({ numItems: 5, cursor: null });
      return 1;
    }),
  });
  const s = createServer({ engine, functions, port: 0, http, redactLogsToClient: false });
  stops.push(() => s.stop());
  const api = `http://127.0.0.1:${s.server!.port}`;
  const completions = async (n: number) => {
    for (let i = 0; i < 400; i++) {
      const r = await fetch(`${api}/api/stream_function_logs?cursor=0`, {
        headers: { authorization: `Bunvex ${KEY}` },
      });
      const parts = ((await r.json()) as { entries: Part[] }).entries.filter(
        (p) => p.kind === "Completion" && p.udfType === "HttpAction",
      );
      if (parts.length >= n) return parts as Record<string, unknown>[];
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  return { site: s.siteUrl!, completions };
}

test("a system error answers Convex's internal error, its detail in the server's log only", async () => {
  const t = await setup();
  const logged: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
  });
  try {
    const answers: Record<string, unknown> = {};
    for (const kind of Object.keys(failures)) {
      const r = await fetch(`${t.site}/fail/${kind}`);
      const text = await r.text();
      answers[kind] = { status: r.status, type: r.headers.get("content-type"), body: JSON.parse(text) };
    }
    expect(answers.executor).toEqual({ status: 500, type: "application/json", body: INTERNAL });
    expect(answers.page).toEqual({ status: 500, type: "application/json", body: INTERNAL });
    // Convex's `out_of_retention` has the same code and message, as a 503.
    expect(answers.retention).toEqual({ status: 503, type: "application/json", body: INTERNAL });
    expect(answers.indexes).toEqual({
      status: 503,
      type: "application/json",
      body: { code: "SearchIndexesUnavailable", message: "Search indexes are not ready yet" },
    });
    // The app's own throw is unchanged: its message and trace.
    expect(answers.thrown).toMatchObject({ status: 500, body: { trace: expect.stringContaining("the app's own") } });
    for (const kind of ["executor", "page", "retention", "indexes"])
      expect(JSON.stringify(answers[kind])).not.toMatch(/Uncaught|forged|Cursor was None|Timestamp|trace/);

    // The detail is in the server's log, one line per failure, never for the app's own throw.
    const lines = logged.filter((l) => l.includes("failed with an internal error"));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toStartWith(`bunvex: the HTTP action of GET /fail/executor failed with an internal error: `);
    expect(lines[0]).toContain(DETAIL);
    expect(lines[1]).toContain("Cursor was None");
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);

    // Logged under the request, with the fixed message, its lines kept; the app's throw with its own error.
    const done = await t.completions(5);
    expect(done.map((c) => c.identifier)).toEqual(Object.keys(failures).map((k) => `GET /fail/${k}`));
    expect(done.slice(0, 4).map((c) => c.error)).toEqual(Array(4).fill(`${INTERNAL.message}\n`));
    expect(done[4]!.error).toStartWith("Uncaught Error: the app's own\n");
  } finally {
    spy.mockRestore();
  }
});
