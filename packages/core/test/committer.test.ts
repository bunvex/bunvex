import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitterStoppedError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import type { Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { Schema } from "../src/schema.ts";

const schema = new Schema().table("items", { by_n: ["n"] });
const dirs: string[] = [];
afterEach(() => {
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
      const reopened = await new Engine(schema, await MemoryPersistence.open(path, { durable: true })).init();
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
