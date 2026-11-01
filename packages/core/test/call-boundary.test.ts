// STUDY-194, STUDY-190 PR 2a: a call crosses the boundary as text. The body runner gets the request decoded (the
// caller's identity a copy, the arguments as text), and the engine's cache and commit take the outcome decoded.
// Only under the tests (Q7, owner, 2026-10-27): outside them the same objects cross without the codec.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { Call, CallBodies } from "../src/call-runner.ts";
import type { CallRequest } from "../src/call-wire.ts";
import { Engine, parseValue } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

async function engine(opts: { callCodec?: boolean } = {}) {
  return new Engine(
    defineSchema({ items: defineTable({ n: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
    opts,
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
    encodeError: (e) => String((e as Error).message),
    decodeError: (text) => new Error(text),
    capture: (run) => ({ result: run(), report: () => null }),
    replay: () => {},
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

test("under the tests every engine round-trips its calls through the codec (the preload turns it on)", async () => {
  expect((await engine()).callCodec).toBe(true);
});

test("without the codec, as outside the tests: the same request and identity objects, the same cache and commit", async () => {
  const e = await engine({ callCodec: false });
  expect(e.callCodec).toBe(false);
  const { seen, call } = recording(async (db) => (await db.query("items").collect()).length);
  const identity = { tokenIdentifier: "t|1", subject: "1", issuer: "t" };
  const caller = { identity, key: JSON.stringify(identity) };
  expect(await e.queryJson(call("query", {}), "key", undefined, caller)).toBe("0");
  // No text: the identity is the caller's own object, and the request carries none.
  expect(seen[0]!.identity).toBe(identity);
  expect(seen[0]!.request.identity).toBe(null);
  expect(await e.queryJson(call("query", {}), "key", undefined, caller)).toBe("0");
  expect(seen.length).toBe(1);
  const writer = recording(async (db, args) => db.insert("items", args as { n: number }));
  await e.mutationWithTs(writer.call("mutation", { n: 5 }), "m:f");
  expect(await e.queryJson(call("query", {}), "key", undefined, caller)).toBe("1");
  expect(seen.length).toBe(2);
});

// STUDY-194 §4.7, 2b commit 0d: a request names the metadata's epoch at dispatch; under the codec a query's call
// begins with that epoch's catalog as a worker would have been sent it, not the engine's own object.
test("a query's call begins with its epoch's catalog, sent through the codec; a table a mutation created is a new epoch", async () => {
  const e = await engine();
  const catalogs: unknown[] = [];
  const { seen, call } = recording(async (db) => {
    catalogs.push((db as unknown as { catalog: unknown }).catalog);
    return (await db.query("notes").collect()).length;
  });
  expect(await e.queryJson(call("query", {}))).toBe("0");
  const before = e.metadataEpoch;
  expect(e.metadataEpoch).toBe(before);
  // Created by an insert: the catalog changes in place.
  await e.mutation((db) => db.insert("notes", { text: "hi" }));
  expect(e.metadataEpoch).toBe(before + 1);
  expect(await e.queryJson(call("query", {}))).toBe("1");
  expect(seen.map((s) => s.request.metadata)).toEqual([before, before + 1]);
  expect(catalogs[1]).not.toBe(e.catalog);
  expect(catalogs[1]).toEqual(e.catalog);
});

test("a query's call through the codec sees an index's state as the engine does: a staged index stays staged", async () => {
  const e = await new Engine(
    defineSchema({ items: defineTable({ n: v.number() }).index("by_n", { fields: ["n"], staged: true }) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const { call } = recording(async (db) => db.query("items").withIndex("by_n").collect());
  await expect(e.queryJson(call("query", {}))).rejects.toThrow(
    "Index items.by_n is currently staged and not available to query until it is enabled.",
  );
});

// What a subscription does: a commit's listener reruns the query at that commit. A table the commit created is in the
// catalog by then (before, it was added after the listeners, and a query's copy of the catalog missed it for good).
test("a query a commit's listener dispatches finds the table that commit created", async () => {
  const e = await engine();
  const { call } = recording(async (db) => (await db.query("notes").collect()).length);
  let rerun: Promise<string> | undefined;
  e.committer.onCommit(() => {
    rerun ??= e.queryJson(call("query", {})) as Promise<string>;
  });
  await e.mutation((db) => db.insert("notes", { text: "hi" }));
  expect(await rerun).toBe("1");
});
