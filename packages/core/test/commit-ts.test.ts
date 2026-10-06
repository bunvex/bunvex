// The commit timestamp placeholder (STUDY-53), as Convex's `db.vars.commitTs`: written, it resolves at the
// commit to the commit's timestamp (int64 ns, the mutation's ts), in documents, index entries and the
// result; read back within the mutation it is the placeholder; indexes sort it after every real timestamp.
import { expect, test } from "bun:test";
import { CommitTsPlaceholder, commitTsPlaceholder, MAX_COMMIT_TS, v } from "@bunvex/values";
import { defineSchema, defineTable, Engine, stringifyValue } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

async function engine() {
  return new Engine(
    defineSchema({ events: defineTable(v.any()).index("by_at", ["at"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
}

test("written and returned, it resolves to the commit's timestamp in nanoseconds", async () => {
  const e = await engine();
  const { value, ts } = await e.mutationWithTs(async (db) => {
    const id = await db.insert("events", { at: db.vars!.commitTs, nested: { list: [1n, db.vars!.commitTs] } });
    const back = (await db.get(id))!;
    return { id, at: db.vars!.commitTs, sameObject: back.at === db.vars!.commitTs, nested: back.nested };
  });
  const ns = ts;
  expect(value.at as unknown).toBe(ns);
  expect(value.sameObject).toBe(true);
  expect(value.nested).toEqual({ list: [1n, ns] });
  const stored = await e.query((db) => db.get(value.id));
  expect(stored!.at).toBe(ns);
  expect((stored!.nested as { list: unknown[] }).list[1]).toBe(ns);
});

test("strictly increasing in commit order; an index orders by it", async () => {
  const e = await engine();
  for (let i = 0; i < 3; i++) await e.mutation((db) => db.insert("events", { i, at: db.vars!.commitTs }));
  const docs = await e.query((db) => db.query("events").withIndex("by_at").collect());
  expect(docs.map((d) => d.i)).toEqual([0, 1, 2]);
  const ats = docs.map((d) => d.at as bigint);
  expect(ats[0]! < ats[1]! && ats[1]! < ats[2]!).toBe(true);
});

test("within the mutation: indexed after every real timestamp, found by eq on the placeholder", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("events", { tag: "old", at: 5n }));
  const r = await e.mutation(async (db) => {
    await db.insert("events", { tag: "new", at: db.vars!.commitTs });
    const last = await db.query("events").withIndex("by_at").order("desc").first();
    const mine = await db
      .query("events")
      .withIndex("by_at", (q) => q.eq("at", db.vars!.commitTs))
      .collect();
    return { last: last!.tag, mine: mine.map((d) => d.tag), lastIsPlaceholder: last!.at === commitTsPlaceholder };
  });
  expect(r).toEqual({ last: "new", mine: ["new"], lastIsPlaceholder: true });
});

test("a patch keeps a placeholder it does not touch; replace and overwrite drop it", async () => {
  const e = await engine();
  const { value: id, ts } = await e.mutationWithTs(async (db) => {
    const id = await db.insert("events", { at: db.vars!.commitTs, other: db.vars!.commitTs });
    await db.patch("events", id, { other: 1n, x: "y" });
    return id;
  });
  const d = (await e.query((db) => db.get(id)))!;
  expect(d.at).toBe(ts);
  expect(d.other).toBe(1n);
});

test("it cannot be used as a number; it prints as Convex's; its JSON is Convex's token; queries have no vars", async () => {
  const e = await engine();
  await expect(
    e.mutation(async (db) => {
      const n = Number(db.vars!.commitTs);
      return n;
    }),
  ).rejects.toThrow("This commit timestamp is unresolved");
  expect(String(commitTsPlaceholder)).toBe("[unresolved commit timestamp]");
  expect(commitTsPlaceholder).toBeInstanceOf(CommitTsPlaceholder);
  expect(stringifyValue({ a: commitTsPlaceholder })).toBe('{"a":{"$commitTs":null}}');
  expect(await e.query((db) => db.vars)).toBeUndefined();
  expect(MAX_COMMIT_TS).toBe(9223372036854775807n);
});

test("validators see it as the largest int64: v.commitTs() and v.int64() accept it, v.number() does not", async () => {
  const { checkValue } = await import("@bunvex/values");
  expect(checkValue(v.commitTs(), commitTsPlaceholder)).toBeFalsy();
  expect(checkValue(v.int64(), commitTsPlaceholder)).toBeFalsy();
  expect(checkValue(v.commitTs(), 3n)).toBeFalsy();
  expect(checkValue(v.number(), commitTsPlaceholder)).toContain("Value: 9223372036854775807");
  expect(v.commitTs().json).toEqual({ type: "commitTs" });
});

test("a session request's recorded result resolves on replay to the original commit's timestamp", async () => {
  const e = await engine();
  const run = () =>
    e.sessionMutation(
      async (db) => ({ at: db.vars!.commitTs }),
      "m",
      { sessionId: "s", requestId: 1 },
      (value) => ({ result: stringifyValue(value), logLines: [] }),
    );
  const first = await run();
  const again = await run();
  const at = (first as unknown as { value: { at: bigint } }).value.at;
  expect(at).toBe(first.ts);
  const replayed = (again as { replayed: { result: string } }).replayed.result;
  expect(replayed).toBe(stringifyValue({ at }));
});

test("a commit timestamp in a search filter field is indexed as resolved (with STUDY-45's search indexes)", async () => {
  const e = await new Engine(
    defineSchema({
      messages: defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields: ["at"] }),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await e.searchReady();
  const { ts } = await e.mutationWithTs((db) => db.insert("messages", { body: "hello world", at: db.vars!.commitTs }));
  const ns = ts;
  const hits = await e.query((db) =>
    db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", "hello").eq("at", ns))
      .collect(),
  );
  expect(hits.map((d) => d.at)).toEqual([ns]);
});

test("after the commit, the index holds the resolved timestamp: eq on it finds the document", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("events", { tag: "real", at: 5n }));
  const { ts } = await e.mutationWithTs((db) => db.insert("events", { tag: "committed", at: db.vars!.commitTs }));
  const ns = ts;
  const found = await e.query((db) =>
    db
      .query("events")
      .withIndex("by_at", (q) => q.eq("at", ns))
      .collect(),
  );
  expect(found.map((d) => d.tag)).toEqual(["committed"]);
  // And nothing is left at the placeholder's key, after every real timestamp.
  const above = await e.query((db) =>
    db
      .query("events")
      .withIndex("by_at", (q) => q.gt("at", ns))
      .collect(),
  );
  expect(above).toEqual([]);
});
