// Database calls in flight at the same time in one transaction: Convex runs them one at a time in the order the
// function made them, so a write reads the document as the writes before it left it, and a read made after a write
// sees it (packages/differential/test/concurrent-writes.test.ts compares the same calls with Convex's backend).
import { afterEach, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const schema = defineSchema({ docs: defineTable(v.any()) });
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
});

/** Start `calls` together on a fresh document `{a: 1}`; how each settled, and the document afterwards. */
async function together(
  calls: (db: Tx, id: string) => Promise<unknown>[],
): Promise<{ results: unknown[]; after: unknown }> {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  engines.push(engine);
  return engine.mutation(async (db) => {
    const id = await db.insert("docs", { a: 1 });
    const settled = await Promise.allSettled(calls(db, id));
    const results = settled.map((r) =>
      r.status === "fulfilled" ? { ok: r.value ?? null } : { error: (r.reason as Error).message.replace(id, "<id>") },
    );
    const doc = await db.get("docs", id);
    return { results, after: doc && { ...doc, _id: undefined, _creationTime: undefined } };
  });
}
const fields = (d: unknown): unknown => d && { ...(d as object), _id: undefined, _creationTime: undefined };

test("a second delete of the same document fails, as do a patch and a replace after a delete", async () => {
  expect(await together((db, id) => [db.delete("docs", id), db.delete("docs", id)])).toEqual({
    results: [{ ok: null }, { error: "Delete on nonexistent document ID <id>" }],
    after: null,
  });
  expect(await together((db, id) => [db.delete("docs", id), db.patch("docs", id, { b: 2 })])).toEqual({
    results: [{ ok: null }, { error: "Update on nonexistent document ID <id>" }],
    after: null,
  });
  expect(await together((db, id) => [db.delete("docs", id), db.replace("docs", id, { r: 1 })])).toEqual({
    results: [{ ok: null }, { error: "Replace on nonexistent document ID <id>" }],
    after: null,
  });
});

test("writes apply in order: two patches both apply, and a replace then a patch keeps both", async () => {
  expect((await together((db, id) => [db.patch("docs", id, { b: 2 }), db.patch("docs", id, { c: 3 })])).after).toEqual(
    fields({ a: 1, b: 2, c: 3 }),
  );
  expect(
    (await together((db, id) => [db.replace("docs", id, { r: 1 }), db.patch("docs", id, { c: 3 })])).after,
  ).toEqual(fields({ r: 1, c: 3 }));
  expect(
    (await together((db, id) => [db.patch("docs", id, { c: 3 }), db.replace("docs", id, { r: 1 })])).after,
  ).toEqual(fields({ r: 1 }));
});

test("a read made after a write sees it; one made before does not", async () => {
  const [deleted] = (await together((db, id) => [db.delete("docs", id), db.get("docs", id)])).results.slice(1);
  expect(deleted).toEqual({ ok: null });
  const [before] = (await together((db, id) => [db.get("docs", id).then(fields), db.delete("docs", id)])).results;
  expect(before).toEqual({ ok: fields({ a: 1 }) });
  const [patched] = (
    await together((db, id) => [
      db.patch("docs", id, { b: 2 }),
      db
        .query("docs")
        .collect()
        .then((ds) => ds.map(fields)),
    ])
  ).results.slice(1);
  expect(patched).toEqual({ ok: [fields({ a: 1, b: 2 })] });
  const [paged] = (
    await together((db, id) => [
      db.delete("docs", id),
      db
        .query("docs")
        .paginate({ numItems: 10, cursor: null })
        .then((p) => p.page.length),
    ])
  ).results.slice(1);
  expect(paged).toEqual({ ok: 0 });
  const [iterated] = (
    await together((db, id) => [
      db.delete("docs", id),
      (async () => {
        const out = [];
        for await (const d of db.query("docs")) out.push(d);
        return out.length;
      })(),
    ])
  ).results.slice(1);
  expect(iterated).toEqual({ ok: 0 });
});

test("a lone write still fails at once, with nothing in flight", async () => {
  expect((await together((db, id) => [db.delete("docs", id)])).results).toEqual([{ ok: null }]);
});
