import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Committer, CommitterStoppedError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import type { Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
const dirs: string[] = [];
const open: Persistence[] = [];
afterEach(async () => {
  // Close every log explicitly: Bun turns a FileHandle closed by the GC into an error between tests.
  for (const p of open.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A persistence whose next `flush` (or `apply`) throws, like a full disk. */
function faulty(p: Persistence) {
  const f = { failFlush: false, failApply: false };
  const wrapped: Persistence = Object.create(p);
  wrapped.apply = (ts, docs, idx) => {
    if (f.failApply) throw new Error("SQLITE_IOERR");
    return p.apply(ts, docs, idx);
  };
  wrapped.flush = async () => {
    if (f.failFlush) throw new Error("disk full");
    return p.flush();
  };
  return { wrapped, f };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-committer-"));
  dirs.push(dir);
  const path = join(dir, "log");
  const inner = await MemoryPersistence.open(path, { durable: true });
  open.push(inner);
  const { wrapped, f } = faulty(inner);
  const e = await new Engine(schema, wrapped).init();
  const fatal: Error[] = [];
  e.committer.onFatal((err) => fatal.push(err));
  return { e, f, fatal, inner, path };
}
const count = (e: Engine) => e.query((db) => db.query("items").collect()).then((r) => r.length);

describe("committer fail-stop on persistence failure (Convex: the committer shuts down)", () => {
  for (const which of ["flush", "apply"] as const) {
    test(`a failing ${which}: the commit is refused, never becomes visible, and nothing hangs`, async () => {
      const { e, f, fatal, inner, path } = await setup();
      await e.mutation((db) => db.insert("items", { n: 1 }));
      if (which === "flush") f.failFlush = true;
      else f.failApply = true;
      await expect(e.mutation((db) => db.insert("items", { n: 2 }))).rejects.toThrow(
        which === "flush" ? "disk full" : "SQLITE_IOERR",
      );
      f.failFlush = f.failApply = false; // the disk recovers — the rejected write must still never show up
      await expect(e.mutation((db) => db.insert("items", { n: 3 }))).rejects.toBeInstanceOf(CommitterStoppedError);
      expect(fatal).toHaveLength(1);
      expect(await count(e)).toBe(1);
      expect(
        await e.query((db) =>
          db
            .query("items")
            .withIndex("by_n", (q) => q.eq("n", 2))
            .collect(),
        ),
      ).toEqual([]);
      // Restart: recovery sees only what was durably committed.
      await inner.close();
      open.splice(open.indexOf(inner), 1);
      const again = await MemoryPersistence.open(path, { durable: true });
      open.push(again);
      const reopened = await new Engine(schema, again).init();
      expect(await count(reopened)).toBe(1);
      await reopened.mutation((db) => db.insert("items", { n: 4 }));
      expect(await count(reopened)).toBe(2);
    });
  }

  test("commits queued behind the failing group are refused too", async () => {
    const { e, f } = await setup();
    f.failFlush = true;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => e.mutation((db) => db.insert("items", { n: i }))),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    f.failFlush = false;
    expect(await count(e)).toBe(0);
  });
});

test("a commit queued right after another resolves, in the same microtask chain, is not lost", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const c = new Committer(p);
  const idx = (n: number) => [{ index: 9, key: new Uint8Array([n]), id: `d${n}` }];
  const second = c
    .commit({ snapshot: 0, reads: [], docs: [], idx: idx(1) })
    .then(() => c.commit({ snapshot: 1, reads: [], docs: [], idx: idx(2) }));
  const ts = await Promise.race([second, new Promise((r) => setTimeout(() => r("stuck"), 500))]);
  expect(ts).toBe(2);
});
