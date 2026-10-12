// The SQLite store on its own (persistence/sqlite.ts): refusing a file that is not its own, the read-only flag,
// the single-writer lock, descending scans, references to missing documents, the document log while a group is
// open, and retention. The conformance suite checks these from outside, much of it in child processes; mutation
// testing (TEST-01 §7) found no core test noticing them, so these drive the store directly.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalIdString } from "../src/internal-id.ts";
import { DanglingReferenceError, LeaseLostError } from "../src/persistence/index.ts";
import { LayoutError, ReadOnlyError } from "../src/persistence/layout.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";

const dirs: string[] = [];
const open: SqlitePersistence[] = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dbPath = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-sqlite-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const openDb = (path: string, opts: { allowReadOnly?: boolean } = {}) => {
  const s = new SqlitePersistence(path, { durable: false, ...opts });
  open.push(s);
  return s;
};
/** An internal id (16 bytes) whose bytes are all `n`. */
const id = (n: number) => internalIdString(new Uint8Array(16).fill(n));
const T = id(200);
const I = id(201);
const key = (...b: number[]) => Uint8Array.from(b);
const doc = (d: string, json: string | null, prevTs: bigint | null = null) => ({ table: T, id: d, json, prevTs });
const entry = (k: Uint8Array, d: string | null) => ({ index: I, key: k, table: d === null ? null : T, id: d });

describe("opening", () => {
  test("a file that is not a SQLite database is refused, and its lock released", () => {
    const path = dbPath();
    writeFileSync(path, "x".repeat(4096));
    expect(() => openDb(path)).toThrow(
      new LayoutError(`the SQLite store ${path} is not a bunvex store: the file is not a SQLite database`),
    );
    rmSync(path);
    const s = openDb(path); // the failed open let its lock go
    s.apply(1n, [doc(id(1), '"x"')], []);
    s.flush();
  });

  test("the read-only flag: set, the store does not open for writing unless allowed; cleared, it opens", () => {
    const path = dbPath();
    const s = openDb(path);
    s.setReadOnly(true);
    s.close();
    expect(() => openDb(path)).toThrow(ReadOnlyError);
    expect(() => openDb(path)).toThrow(`the SQLite store ${path} is read-only`);
    const reader = openDb(path, { allowReadOnly: true });
    reader.setReadOnly(false);
    reader.close();
    openDb(path).close();
  });

  test("an in-memory store (':memory:' or '') has no lock to take: its lease is always its own", async () => {
    for (const path of [":memory:", ""]) {
      const s = openDb(path);
      expect(await s.acquireLease({ holder: "h", ttlMs: 1000 })).toEqual({ epoch: 1 });
      await s.releaseLease();
      s.apply(1n, [doc(id(1), '"x"')], []); // still a writer
      s.flush();
      expect(existsSync(`${path}.lock`)).toBe(false);
    }
    expect(openDb(":memory:").leaseScope).toBe("process");
  });
});

describe("one writer per file", () => {
  test("a second handle on a held file cannot write, and takes over once the first releases it", async () => {
    const path = dbPath();
    const first = openDb(path);
    expect(await first.acquireLease({ holder: "first", ttlMs: 1000 })).toMatchObject({ epoch: expect.any(Number) });
    const second = openDb(path);
    const held = await second.acquireLease({ holder: "second", ttlMs: 1000 });
    expect(held).toEqual({ heldBy: "first", expiresInMs: null }); // the holder the first recorded
    expect(() => second.apply(1n, [], [])).toThrow(new LeaseLostError("another process holds this SQLite store"));
    expect(() => second.writeIndexEntries([])).toThrow(LeaseLostError);
    expect(() => second.pruneDocuments([])).toThrow(LeaseLostError);
    expect(() => second.pruneIndexes([])).toThrow(LeaseLostError);
    expect(() => second.setGlobal("g", 1)).toThrow(LeaseLostError);
    await first.releaseLease();
    expect("epoch" in (await second.acquireLease({ holder: "second", ttlMs: 1000 }))).toBe(true);
    second.apply(1n, [doc(id(1), '"x"')], []);
    second.flush();
    second.setReadOnly(true);
    expect(() => openDb(path)).toThrow(ReadOnlyError); // refused without the lock, which another handle holds
    second.setReadOnly(false);
    first.close();
    second.close();
    const third = openDb(path); // closing released the lock
    expect("epoch" in (await third.acquireLease({ holder: "third", ttlMs: 1000 }))).toBe(true);
  });
});

describe("reads", () => {
  test("a descending scan returns keys in descending order", () => {
    const s = openDb(":memory:");
    s.apply(
      1n,
      [doc(id(1), '"a"'), doc(id(2), '"b"'), doc(id(3), '"c"')],
      [entry(key(1), id(1)), entry(key(2), id(2)), entry(key(3), id(3))],
    );
    s.flush();
    const ids = (desc: boolean) => s.scan(T, I, key(), key(9), 1n, 10, desc).map((d) => d.id);
    expect(ids(true)).toEqual([id(3), id(2), id(1)]);
    expect(ids(false)).toEqual([id(1), id(2), id(3)]);
  });

  test("an entry with no document at its ts, or a deleted one, is a dangling reference", () => {
    const s = openDb(":memory:");
    s.apply(1n, [], [entry(key(1), id(1))]); // no document 1 at ts 1
    s.flush();
    const e = (() => {
      try {
        s.scan(T, I, key(), key(9), 1n, 10, false);
      } catch (x) {
        return x as DanglingReferenceError;
      }
    })();
    expect(e).toBeInstanceOf(DanglingReferenceError);
    expect(e).toMatchObject({ id: id(1), ts: 1n, deleted: false });

    const t = openDb(":memory:");
    t.apply(1n, [doc(id(1), null)], [entry(key(1), id(1))]); // the document deleted at the entry's ts
    t.flush();
    expect(() => t.scan(T, I, key(), key(9), 1n, 10, false)).toThrow("Index reference to deleted document");
  });

  test("a deleted document reads as absent; an earlier snapshot still sees it", () => {
    const s = openDb(":memory:");
    s.apply(1n, [doc(id(1), '"x"')], []);
    s.apply(2n, [doc(id(1), null, 1n)], []);
    s.flush();
    expect(s.get(T, id(1), 2n)).toBeNull();
    expect(s.get(T, id(1), 1n)).toEqual({ json: '"x"', ts: 1n });
    expect(s.getVersions(T, [id(1), id(9)], 2n)).toEqual([null, null]);
    expect(s.getVersions(T, [id(1)], 1n)).toEqual([{ json: '"x"', ts: 1n }]);
  });

  test("the audits: every stored row, and the live documents of one table at a ts", () => {
    const s = openDb(":memory:");
    s.apply(1n, [doc(id(1), '"x"'), doc(id(2), '"y"')], [entry(key(1), id(1))]);
    s.apply(2n, [doc(id(1), null, 1n)], [entry(key(1), null)]);
    s.flush();
    expect(s.auditRowCount()).toEqual({ docs: 3, idx: 2 });
    expect(s.auditLiveDocs(T, 1n)).toBe(2);
    expect(s.auditLiveDocs(T, 2n)).toBe(1);
  });

  test("printed by name only (inspect.ts)", () => {
    expect(Bun.inspect(openDb(":memory:"))).toBe("SqlitePersistence {…}");
  });
});

describe("the document log (PERSIST-01 C12)", () => {
  test("a group applied but not flushed is left out, on a new handle too", () => {
    const path = dbPath();
    const s = openDb(path);
    s.apply(1n, [doc(id(1), '"x"')], []);
    s.flush();
    s.close();
    const again = openDb(path);
    again.apply(2n, [doc(id(2), '"y"')], []); // its transaction is open
    expect(again.readDocumentLog(0n, 10n, 10).map((r) => r.ts)).toEqual([1n]);
    expect(again.readDocumentLog(0n, 1n, 10).map((r) => r.ts)).toEqual([1n]);
    again.flush();
    again.apply(3n, [doc(id(3), '"z"')], []); // durable through 2 now; still, no row above upToTs
    expect(again.readDocumentLog(0n, 1n, 10).map((r) => r.ts)).toEqual([1n]);
    again.flush();
    expect(again.readDocumentLog(0n, 10n, 10).map((r) => r.ts)).toEqual([1n, 2n, 3n]);
  });

  test("a limit of 0 or less reads nothing", () => {
    const s = openDb(":memory:");
    s.apply(1n, [doc(id(1), '"x"')], []);
    s.flush();
    expect(s.readDocumentLog(0n, 10n, 0)).toEqual([]);
    expect(s.readDocumentLog(0n, 10n, -1)).toEqual([]);
  });
});

describe("index entries at past timestamps (PERSIST-01 C17)", () => {
  test("inside an open group they join its transaction", () => {
    const s = openDb(":memory:");
    s.apply(1n, [doc(id(1), '"x"')], []);
    s.writeIndexEntries([{ ...entry(key(1), id(1)), ts: 1n }]);
    s.flush();
    s.flush(); // nothing open: nothing to commit
    expect(s.scan(T, I, key(), key(9), 1n, 10, false).map((d) => d.id)).toEqual([id(1)]);
  });
});
