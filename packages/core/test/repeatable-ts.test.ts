// STUDY-133 PR 4: persistence globals with integers above 2^53 (Convex's `max_repeatable_ts`, a plain JSON number
// of nanoseconds), the committer's `max_repeatable_ts` bumps, and the `_db.version` policy (DV-418).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { DATABASE_GLOBALS_TABLE } from "../src/catalog.ts";
import { MAX_REPEATABLE_TS_GLOBAL } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { decodeGlobal, encodeGlobal } from "../src/persistence/global-json.ts";
import { LayoutError } from "../src/persistence/layout.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const BIG = 1791309835128171000n;

const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir() {
  const d = mkdtempSync(join(tmpdir(), "bunvex-repeatable-"));
  dirs.push(d);
  return d;
}
async function open(path: string, opts: ConstructorParameters<typeof Engine>[2] = {}) {
  const e = await new Engine(schema, new SqlitePersistence(path, { durable: false }), opts).init();
  engines.push(e);
  return e;
}
async function close(e: Engine) {
  engines.splice(engines.indexOf(e), 1);
  await e.close();
}
const until = async (f: () => boolean, ms = 3000) => {
  const end = performance.now() + ms;
  while (!f()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("global JSON", () => {
  test("an integer above 2^53 round-trips exactly as a plain JSON number; others are unchanged", () => {
    expect(encodeGlobal(BIG)).toBe("1791309835128171000");
    expect(decodeGlobal("1791309835128171000")).toBe(BIG);
    const nested = { a: [BIG, 1, 2.5, -3], b: { c: -BIG, d: "1791309835128171000", e: null }, f: 9007199254740991 };
    const text = encodeGlobal(nested);
    expect(text).toBe(
      '{"a":[1791309835128171000,1,2.5,-3],"b":{"c":-1791309835128171000,"d":"1791309835128171000","e":null},"f":9007199254740991}',
    );
    expect(decodeGlobal(text)).toEqual(nested);
    // Safe integers stay numbers; Convex's `{"$integer": …}` values pass through as they are.
    expect(decodeGlobal("42")).toBe(42);
    expect(decodeGlobal('{"$integer":"+AldBJYC3Bg="}')).toEqual({ $integer: "+AldBJYC3Bg=" });
  });

  test("SQLite and the memory log keep a bigint global across a reopen", async () => {
    const d = dir();
    const s1 = new SqlitePersistence(join(d, "db.sqlite3"), { durable: false });
    s1.setGlobal("big", { ts: BIG });
    s1.close();
    const s2 = new SqlitePersistence(join(d, "db.sqlite3"), { durable: false });
    expect(s2.getGlobal("big")).toEqual({ ts: BIG });
    s2.close();

    const m1 = await MemoryPersistence.open(join(d, "log"), { durable: false });
    await m1.acquireLease({ holder: "t", ttlMs: 1000 });
    await m1.setGlobal("big", BIG);
    expect(m1.getGlobal("big")).toBe(BIG);
    await m1.close();
    const m2 = await MemoryPersistence.open(join(d, "log"), { durable: false });
    await m2.acquireLease({ holder: "t", ttlMs: 1000 });
    expect(m2.getGlobal("big")).toBe(BIG);
    await m2.close();
  });
});

describe("max_repeatable_ts", () => {
  test("an open records a bound at or above the store's newest commit and the clock", async () => {
    const path = join(dir(), "db.sqlite3");
    const e1 = await open(path);
    await e1.mutation((db) => db.insert("items", { n: 1 }));
    await close(e1);
    const before = BigInt(Date.now()) * 1_000_000n;
    const e2 = await open(path);
    const g = await e2.persistence.getGlobal(MAX_REPEATABLE_TS_GLOBAL);
    expect(typeof g).toBe("bigint");
    expect(g as bigint).toBeGreaterThanOrEqual(await e2.persistence.maxTs!());
    expect(g as bigint).toBeGreaterThanOrEqual(before);
    expect(e2.committer.visibleTs).toBe(g as bigint);
  });

  test("a bound far ahead of the clock puts every commit above it", async () => {
    const path = join(dir(), "db.sqlite3");
    await close(await open(path));
    const ahead = BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n; // an hour ahead
    const p = new SqlitePersistence(path, { durable: false });
    p.setGlobal(MAX_REPEATABLE_TS_GLOBAL, ahead);
    p.close();
    const e = await open(path);
    const { ts } = await e.mutationWithTs((db) => db.insert("items", { n: 1 }));
    expect(ts).toBeGreaterThan(ahead);
  });

  test("a commit is followed by a bump to at least its ts", async () => {
    const e = await open(join(dir(), "db.sqlite3"), { repeatableTs: { commitDelayMs: 20, idleMs: 60_000 } });
    // The first bump after the open (the commit delay) lands; then a commit brings the next one forward.
    await until(() => e.committer.repeatableBumps >= 1);
    const { ts } = await e.mutationWithTs((db) => db.insert("items", { n: 1 }));
    // A bump already being written may land below the commit; the follow-up one covers it (c04e2f7), long before
    // the idle minute.
    await until(() => (e.persistence.getGlobal(MAX_REPEATABLE_TS_GLOBAL) as unknown as bigint) >= ts);
  });

  test("a commit published while a bump is written gets its own bump after the commit delay (Convex c04e2f7)", async () => {
    const e = await open(join(dir(), "db.sqlite3"), { repeatableTs: { commitDelayMs: 20, idleMs: 60_000 } });
    e.committer.stopRepeatableBumps();
    const written: bigint[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    e.committer.startRepeatableBumps(
      async (ts) => {
        if (written.push(ts) === 1) await gate;
      },
      { commitDelayMs: 20, idleMs: 60_000 },
    );
    await until(() => written.length === 1); // the first bump is being written
    const { ts } = await e.mutationWithTs((db) => db.insert("items", { n: 1 }));
    expect(written[0]!).toBeLessThan(ts);
    release();
    // Not the idle bump an hour away: another after the commit delay, at or above the commit.
    await until(() => written.length >= 2, 1000);
    expect(written[1]!).toBeGreaterThanOrEqual(ts);
  });

  test("an idle bump takes the next commit ts and makes it visible", async () => {
    const e = await open(join(dir(), "db.sqlite3"), { repeatableTs: { commitDelayMs: 10, idleMs: 10 } });
    const applied = e.committer.appliedTs;
    // A bump while the start's own commits are still in flight writes the last visible ts, not a new one:
    // wait for the first idle bump, however busy the machine is.
    let g = 0n;
    await until(() => {
      g = e.persistence.getGlobal(MAX_REPEATABLE_TS_GLOBAL) as unknown as bigint;
      return typeof g === "bigint" && g > applied;
    });
    expect(e.committer.appliedTs).toBeGreaterThanOrEqual(g);
    await until(() => e.committer.visibleTs >= g); // visible once its write has returned
    // A commit afterwards is above it.
    const { ts } = await e.mutationWithTs((db) => db.insert("items", { n: 1 }));
    expect(ts).toBeGreaterThan(g);
  });

  test("close stops the bumps: nothing is written to the closed store", async () => {
    const errors = spyOn(console, "error");
    try {
      const e = await open(join(dir(), "db.sqlite3"), { repeatableTs: { commitDelayMs: 5, idleMs: 5 } });
      await e.mutation((db) => db.insert("items", { n: 1 }));
      await close(e);
      const bumps = e.committer.repeatableBumps;
      await new Promise((r) => setTimeout(r, 60));
      expect(e.committer.repeatableBumps).toBe(bumps);
      expect(errors.mock.calls.filter((c) => String(c[0]).includes("max_repeatable_ts"))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("_db.version", () => {
  async function storeAt(version: bigint) {
    const path = join(dir(), "db.sqlite3");
    const e = await open(path);
    await e.mutation(async (db) => {
      const row = (await db.asSystem(() => db.query(DATABASE_GLOBALS_TABLE).first())) as { _id: string };
      await db.asSystem(() => db.patch(DATABASE_GLOBALS_TABLE, row._id, { version }));
    });
    await close(e);
    return path;
  }
  // What a refused open must leave as it was: the newest commit and the `max_repeatable_ts` bound.
  const maxTsOf = (path: string) => {
    const p = new SqlitePersistence(path, { durable: false, allowReadOnly: true });
    try {
      return [p.maxTs(), p.getGlobal(MAX_REPEATABLE_TS_GLOBAL)];
    } finally {
      p.close();
    }
  };

  test("an older version is refused, naming both, before anything is written", async () => {
    const path = await storeAt(132n);
    const before = maxTsOf(path);
    let err: unknown = null;
    try {
      await open(path);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LayoutError);
    expect((err as Error).message).toContain("132");
    expect((err as Error).message).toContain("133");
    expect(maxTsOf(path)).toEqual(before);
    // No bump of the refused start writes to the store later.
    await new Promise((r) => setTimeout(r, 30));
    expect(maxTsOf(path)).toEqual(before);
  });

  test("a newer version opens with a warning; the current one silently", async () => {
    const warn = spyOn(console, "warn");
    try {
      const newer = await storeAt(134n);
      warn.mockClear();
      await close(await open(newer));
      expect(warn.mock.calls.some((c) => String(c[0]).includes("134"))).toBe(true);
      const current = await storeAt(133n);
      warn.mockClear();
      await close(await open(current));
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("version"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
