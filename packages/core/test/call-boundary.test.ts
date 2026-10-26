// STUDY-194, STUDY-190 PR 2a: a call crosses the boundary as text. The body runner gets the request decoded (the
// caller's identity a copy, the arguments as text), and the engine's cache and commit take the outcome decoded.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { Call, CallBodies } from "../src/call-runner.ts";
import type { CallRequest } from "../src/call-wire.ts";
import { Engine, parseValue } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

async function engine() {
  return new Engine(
    defineSchema({ items: defineTable({ n: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
}

/** Bodies that record what the runner was handed. */
function recording(run: (db: Tx, args: unknown) => Promise<unknown>) {
  const seen: { request: CallRequest; identity: unknown }[] = [];
  const bodies: CallBodies = {
    body: (request) => async (db) => {
      seen.push({ request, identity: db.identity });
      return run(db, parseValue(request.args));
    },
    record: (value) => ({ result: JSON.stringify(value), logLines: [] }),
  };
  const call = (kind: "query" | "mutation", args: unknown): Call => ({
    spec: { kind, name: "m:f", args: JSON.stringify(args), internal: false, session: null },
    bodies,
  });
  return { seen, call };
}

test("the runner gets the request as text: the arguments, a copy of the identity, the snapshot it runs at", async () => {
  const e = await engine();
  const { seen, call } = recording(async (db) => (await db.query("items").collect()).length);
  const identity = { tokenIdentifier: "t|1", subject: "1", issuer: "t" };
  const caller = { identity, key: JSON.stringify(identity) };
  expect(await e.query<number>(call("query", { a: 1 }), undefined, undefined, caller)).toBe(0);
  expect(await e.queryJson(call("query", { a: 2 }), undefined, undefined, caller)).toBe("0");
  expect(seen.map((s) => s.request.args)).toEqual(['{"a":1}', '{"a":2}']);
  expect(seen[0]!.identity).toEqual(identity);
  expect(seen[0]!.identity).not.toBe(identity);
  expect(seen[1]!.request.id).toBe(seen[0]!.request.id + 1);
  expect(seen[0]!.request.ts).toBe(e.committer.visibleTs);
});

test("a cached call's read set is the outcome's: a write into it runs the call again", async () => {
  const e = await engine();
  const { seen, call } = recording(async (db) => (await db.query("items").collect()).length);
  expect(await e.queryJson(call("query", {}), "key")).toBe("0");
  expect(await e.queryJson(call("query", {}), "key")).toBe("0");
  expect(seen.length).toBe(1);
  await e.mutation((db) => db.insert("items", { n: 1 }));
  expect(await e.queryJson(call("query", {}), "key")).toBe("1");
  expect(seen.length).toBe(2);
});

test("a call's writes are committed from its outcome; a subscription's run carries its reads and its text", async () => {
  const e = await engine();
  const { call } = recording(async (db, args) => db.insert("items", args as { n: number }));
  const { ts } = await e.mutationWithTs(call("mutation", { n: 5 }), "m:f");
  expect(ts).toBe(e.committer.visibleTs);
  const reader = recording(async (db) => (await db.query("items").collect()).map((d) => d.n));
  const run = await e.queryTracked(reader.call("query", {}));
  expect(run.ok && run.json).toBe("[5]");
  expect(run.reads.length).toBeGreaterThan(0);
  expect(e.committer.changedBetween(run.reads, run.ts, run.ts)).toBe(false);
  await e.mutation((db) => db.insert("items", { n: 6 }));
  expect(e.committer.changedBetween(run.reads, run.ts, e.committer.visibleTs)).toBe(true);
});
