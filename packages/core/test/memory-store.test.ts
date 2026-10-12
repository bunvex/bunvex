// The memory store on its own (persistence/memory.ts): its log's first line (PERSIST-01 C10), a torn tail, the
// read-only flag, the single-writer lock, retention's bounds, index entries at past timestamps and the reads.
// The conformance suite (bench/conformance.test.ts) checks these on the store from outside, much of it in child
// processes; mutation testing (TEST-01 §7) found no core test noticing them, so these drive the store directly.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DanglingReferenceError, LeaseLostError } from "../src/persistence/index.ts";
import { LAYOUT_VERSION, LayoutError, ReadOnlyError } from "../src/persistence/layout.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const dirs: string[] = [];
const open: MemoryPersistence[] = [];
afterEach(async () => {
  for (const m of open.splice(0)) await m.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const logPath = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-memory-"));
  dirs.push(d);
  return join(d, "log.jsonl");
};
const openLog = async (path: string | null, opts: { allowReadOnly?: boolean } = {}) => {
  const m = await MemoryPersistence.open(path, { durable: false, ...opts });
  open.push(m);
  return m;
};
const HEADER = `${JSON.stringify({ layout: LAYOUT_VERSION })}\n`;
const key = (...b: number[]) => Uint8Array.from(b);
const doc = (id: string, json: string | null, prevTs: bigint | null = null) => ({ table: "t", id, json, prevTs });
const entry = (k: Uint8Array, id: string | null) => ({ index: "i", key: k, table: id === null ? null : "t", id });

describe("the log's first line (PERSIST-01 C10)", () => {
  test("a new log starts with the layout header, and opens again", async () => {
    const path = logPath();
    const m = await openLog(path);
    m.apply(1n, [doc("a", '"x"')], []);
    await m.flush();
    await m.close();
    expect(readFileSync(path, "utf8").startsWith(HEADER)).toBe(true);
    const again = await openLog(path);
    expect(again.get("t", "a", 1n)).toEqual({ json: '"x"', ts: 1n });
  });

  test("an empty file is a new log", async () => {
    const path = logPath();
    writeFileSync(path, "");
    await openLog(path);
    expect(readFileSync(path, "utf8")).toBe(HEADER);
  });

  test("a first line that is not a header or a record is refused before the lock is taken; the file is untouched", async () => {
    for (const line of ["hello\n", "5\n", "null\n", '{"x":1}\n', '"layout"\n', "hello"]) {
      const path = logPath();
      writeFileSync(path, line);
      const e = await openLog(path).catch((x) => x);
      expect(e).toBeInstanceOf(LayoutError);
      expect(e.message).toBe(
        `the memory store's log ${path} is not a bunvex store: its first line is neither a layout header nor a commit record`,
      );
      expect(readFileSync(path, "utf8")).toBe(line);
      expect(existsSync(`${path}.lock`)).toBe(false);
    }
  });

  test("a later header of another layout version is refused, and the lock let go", async () => {
    const path = logPath();
    writeFileSync(path, `${HEADER}${JSON.stringify({ layout: LAYOUT_VERSION + 1 })}\n`);
    await expect(openLog(path)).rejects.toThrow(/was written by a newer bunvex/);
    writeFileSync(path, HEADER);
    const m = await openLog(path); // the failed open released the lock: this one loads and writes
    expect("epoch" in (await m.acquireLease({ holder: "h", ttlMs: 1000 }))).toBe(true);
    m.apply(1n, [doc("a", '"x"')], []);
    await m.flush();
  });

  test("a log of another layout version is refused", async () => {
    const path = logPath();
    writeFileSync(path, `${JSON.stringify({ layout: LAYOUT_VERSION + 1 })}\n`);
    await expect(openLog(path)).rejects.toThrow(/was written by a newer bunvex/);
  });

  test("a first line longer than the 4 KB peek: refused when it is not ours, whether or not it looks like JSON", async () => {
    for (const line of [`${"x".repeat(5000)}\n`, `{"zz":"${"x".repeat(5000)}"}\n`]) {
      const path = logPath();
      writeFileSync(path, line);
      await expect(openLog(path)).rejects.toBeInstanceOf(LayoutError);
    }
  });
});

describe("a torn tail", () => {
  test("a last line without its terminator, or that does not parse, is cut off; what precedes it stays", async () => {
    for (const tail of ['{"ts":"9","docs":[', '{"ts":"9"\n']) {
      const path = logPath();
      const m = await openLog(path);
      m.apply(1n, [doc("a", '"x"')], [entry(key(1), "a")]);
      await m.flush();
      await m.close();
      const good = statSync(path).size;
      appendFileSync(path, tail);
      const again = await openLog(path);
      expect(again.maxTs()).toBe(1n);
      expect(again.get("t", "a", 5n)).toEqual({ json: '"x"', ts: 1n });
      expect(statSync(path).size).toBe(good);
    }
  });
});

describe("the read-only flag", () => {
  test("set, the log does not open for writing unless allowed; cleared, it opens", async () => {
    const path = logPath();
    const m = await openLog(path);
    await m.setReadOnly(true);
    expect(existsSync(`${path}.read-only`)).toBe(true);
    await m.close();
    rmSync(`${path}.lock`);
    const e = await openLog(path).catch((x) => x);
    expect(e).toBeInstanceOf(ReadOnlyError);
    expect(existsSync(`${path}.lock`)).toBe(false); // refused before the lock is taken
    expect(e.message).toContain(`the memory store's log ${path} is read-only`);
    const reader = await openLog(path, { allowReadOnly: true });
    await reader.setReadOnly(false);
    expect(existsSync(`${path}.read-only`)).toBe(false);
    await reader.setReadOnly(false); // clearing a flag that is not set is fine
    await reader.close();
    await openLog(path);
  });

  test("a store without a log has nothing to mark", async () => {
    const m = await openLog(null);
    await m.setReadOnly(true);
    expect(existsSync("null.read-only")).toBe(false);
    expect(m.leaseScope).toBe("process");
    expect(await m.acquireLease({ holder: "h", ttlMs: 1000 })).toEqual({ epoch: 1 });
  });
});

describe("one writer per log", () => {
  test("a second open of a held log neither loads nor writes it, and takes over once it is released", async () => {
    const path = logPath();
    const first = await openLog(path);
    first.apply(1n, [doc("a", '"x"')], []);
    await first.flush();
    expect(await first.acquireLease({ holder: "first", ttlMs: 1000 })).toMatchObject({ epoch: expect.any(Number) });

    const second = await openLog(path);
    expect(second.maxTs()).toBe(0n); // not loaded: the log is another writer's
    const held = await second.acquireLease({ holder: "second", ttlMs: 1000 });
    expect(held).toEqual({ heldBy: "first", expiresInMs: null }); // the holder the first recorded
    expect(() => second.apply(2n, [doc("b", '"y"')], [])).toThrow(
      new LeaseLostError("another process holds this memory store's log"),
    );
    expect(() => second.pruneDocuments([], 1n)).toThrow(LeaseLostError);
    expect(() => second.pruneIndexes([], 1n)).toThrow(LeaseLostError);
    await expect(second.setGlobal("g", 1)).rejects.toThrow(LeaseLostError);
    await expect(second.writeIndexEntries([])).rejects.toThrow(LeaseLostError);

    await first.releaseLease();
    const taken = await second.acquireLease({ holder: "second", ttlMs: 1000 });
    expect("epoch" in taken).toBe(true);
    expect(second.maxTs()).toBe(1n); // loaded when taken
    second.apply(2n, [doc("b", '"y"')], []);
    await second.flush();
  });
});

describe("reads", () => {
  test("a deleted document reads as absent; an earlier snapshot still sees it", async () => {
    const m = await openLog(null);
    m.apply(1n, [doc("a", '"x"')], []);
    m.apply(2n, [doc("a", null, 1n)], []);
    expect(m.get("t", "a", 2n)).toBeNull();
    expect(m.get("t", "a", 1n)).toEqual({ json: '"x"', ts: 1n });
    expect(m.getVersions("t", ["a"], 2n)).toEqual([null]);
  });

  test("a scan stops at its limit, and its upper bound is exclusive", async () => {
    const m = await openLog(null);
    m.apply(1n, [doc("a", '"a"'), doc("b", '"b"')], [entry(key(1), "a"), entry(key(2), "b")]);
    expect(m.scan("t", "i", key(), key(9), 1n, 1, false).map((d) => d.id)).toEqual(["a"]);
    expect(m.scan("t", "i", key(), key(9), 1n, 1, true).map((d) => d.id)).toEqual(["b"]);
    for (const limit of [0, -1]) expect(m.scan("t", "i", key(), key(9), 1n, limit, false)).toEqual([]);
    expect(m.scan("t", "i", key(), key(2), 1n, 10, false).map((d) => d.id)).toEqual(["a"]);
    expect(m.scan("t", "i", key(), key(2), 1n, 10, true).map((d) => d.id)).toEqual(["a"]);
  });

  test("an entry with no document at its ts, or a deleted one, is a dangling reference", async () => {
    const m = await openLog(null);
    m.apply(1n, [], [entry(key(1), "a")]); // no document a at ts 1 …
    m.apply(2n, [doc("a", '"later"')], []); // … only a later version
    const e = (() => {
      try {
        m.scan("t", "i", key(), key(9), 2n, 10, false);
      } catch (x) {
        return x as DanglingReferenceError;
      }
    })();
    expect(e).toBeInstanceOf(DanglingReferenceError);
    expect(e).toMatchObject({ id: "a", ts: 1n, deleted: false });
    const d = await openLog(null);
    d.apply(1n, [doc("a", null)], [entry(key(1), "a")]); // deleted at the entry's ts
    expect(() => d.scan("t", "i", key(), key(9), 1n, 10, false)).toThrow("Index reference to deleted document");
  });

  test("a descending scan stops at its lower bound, which it includes", async () => {
    const m = await openLog(null);
    m.apply(
      1n,
      [doc("a", '"a"'), doc("b", '"b"'), doc("c", '"c"')],
      [entry(key(1), "a"), entry(key(2), "b"), entry(key(3), "c")],
    );
    const ids = (lo: Uint8Array, hi: Uint8Array) => m.scan("t", "i", lo, hi, 1n, 10, true).map((d) => d.id);
    expect(ids(key(2), key(9))).toEqual(["c", "b"]);
    expect(ids(key(2), key(3))).toEqual(["b"]);
  });

  test("flushing a store without a log makes its commits durable for the document log", async () => {
    const m = await openLog(null);
    m.apply(1n, [doc("a", '"x"')], []);
    await m.flush();
    expect(m.readDocumentLog(0n, 10n, 10).map((r) => r.ts)).toEqual([1n]);
  });

  test("the audits: every stored version, and the live documents of one table at a ts", async () => {
    const m = await openLog(null);
    m.apply(
      1n,
      [doc("a", '"x"'), doc("b", '"y"'), { table: "u", id: "c", json: '"z"', prevTs: null }],
      [entry(key(1), "a")],
    );
    m.apply(2n, [doc("a", null, 1n)], [entry(key(1), null)]);
    expect(m.auditRowCount()).toEqual({ docs: 4, idx: 2 });
    expect(m.auditLiveDocs("t", 1n)).toBe(2);
    expect(m.auditLiveDocs("t", 2n)).toBe(1);
    expect(m.auditLiveDocs("u", 2n)).toBe(1);
    expect(m.auditLiveDocs("v", 2n)).toBe(0);
    m.apply(3n, [doc("late", '"x"')], []);
    expect(m.auditLiveDocs("t", 2n)).toBe(1); // a document first written after the ts is not counted
  });
});

describe("retention (PERSIST-01 C12, C13)", () => {
  test("the document log: at most `limit` commits, none past the durable ts", async () => {
    const m = await openLog(null);
    for (const ts of [1n, 2n, 3n]) m.apply(ts, [doc(`d${ts}`, '"x"'), doc(`e${ts}`, '"x"')], []);
    await m.flush();
    m.apply(4n, [doc("d4", '"x"')], []); // applied, not yet durable
    expect(m.readDocumentLog(0n, 10n, 2).map((r) => r.ts)).toEqual([1n, 1n, 2n, 2n]);
    expect(m.readDocumentLog(1n, 10n, 10).map((r) => r.ts)).toEqual([2n, 2n, 3n, 3n]);
    expect(m.readDocumentLog(0n, 10n, 0)).toEqual([]);
  });

  test("the document log counts commits that wrote documents, not those that wrote only index entries", async () => {
    const m = await openLog(null);
    m.apply(1n, [doc("a", '"x"')], []);
    m.apply(2n, [], [entry(key(1), null)]);
    m.apply(3n, [doc("b", '"y"')], []);
    await m.flush();
    expect(m.readDocumentLog(0n, 10n, 2).map((r) => r.ts)).toEqual([1n, 3n]);
  });

  test("forgetting the document log stops at the durable ts", async () => {
    const m = await openLog(null);
    m.apply(1n, [doc("a", '"x"')], []);
    await m.flush();
    m.apply(2n, [doc("b", '"y"')], []);
    m.pruneDocuments([], 2n); // 2 is not durable yet: only 1 is forgotten
    await m.flush();
    expect(m.readDocumentLog(0n, 10n, 10).map((r) => r.ts)).toEqual([2n]);
  });

  test("a long-forgotten head of the document log is compacted away, and reads still start after it", async () => {
    const m = await openLog(null);
    for (let ts = 1n; ts <= 2100n; ts++) m.apply(ts, [doc(`d${ts}`, '"x"')], []);
    await m.flush();
    m.pruneDocuments([], 2000n);
    expect(m.readDocumentLog(0n, 3000n, 1000).map((r) => r.ts)).toEqual(
      Array.from({ length: 100 }, (_, i) => 2001n + BigInt(i)),
    );
    m.apply(2101n, [doc("late", '"x"')], []);
    await m.flush();
    m.pruneDocuments([], 2050n);
    expect(m.readDocumentLog(2090n, 3000n, 1000).map((r) => r.ts)).toEqual([
      2091n,
      2092n,
      2093n,
      2094n,
      2095n,
      2096n,
      2097n,
      2098n,
      2099n,
      2100n,
      2101n,
    ]);
    expect(m.readDocumentLog(0n, 3000n, 1)).toEqual([
      { ts: 2051n, table: "t", id: "d2051", deleted: false, prevTs: null },
    ]);
  });

  test("a document version's prev_ts is logged, and replayed", async () => {
    const path = logPath();
    const m = await openLog(path);
    m.apply(1n, [doc("a", '"1"')], []);
    m.apply(2n, [doc("a", '"2"', 1n)], []);
    await m.flush();
    await m.close();
    const again = await openLog(path);
    expect(again.readDocumentLog(0n, 10n, 10).map((r) => r.prevTs)).toEqual([null, 1n]);
  });

  test("pruning drops the versions at or below each ts, and counts them; unknown keys are skipped", async () => {
    const m = await openLog(null);
    m.apply(1n, [doc("a", '"1"')], [entry(key(1), "a")]);
    m.apply(2n, [doc("a", '"2"', 1n)], [entry(key(1), "a")]);
    m.apply(3n, [doc("a", '"3"', 2n)], [entry(key(1), "a")]);
    expect(
      m.pruneIndexes(
        [
          { index: "i", key: key(9), ts: 3n },
          { index: "j", key: key(1), ts: 3n },
        ],
        0n,
      ),
    ).toBe(0);
    expect(m.pruneIndexes([{ index: "i", key: key(1), ts: 2n }], 0n)).toBe(2);
    expect(m.pruneDocuments([{ table: "t", id: "zz", ts: 3n }], 0n)).toBe(0);
    expect(m.pruneDocuments([{ table: "t", id: "a", ts: 2n }], 0n)).toBe(2);
    expect(m.auditRowCount()).toEqual({ docs: 1, idx: 1 });
    expect(m.get("t", "a", 3n)).toEqual({ json: '"3"', ts: 3n });
    expect(m.pruneDocuments([{ table: "t", id: "a", ts: 3n }], 0n)).toBe(1);
    expect(m.pruneIndexes([{ index: "i", key: key(1), ts: 3n }], 0n)).toBe(1);
    expect(m.auditRowCount()).toEqual({ docs: 0, idx: 0 });
  });
});

describe("index entries at past timestamps (PERSIST-01 C17)", () => {
  test("each goes in its commit's place among the key's versions, replacing one already there", async () => {
    const m = await openLog(null);
    m.apply(10n, [doc("a", '"a"')], [entry(key(1), "a")]);
    m.apply(20n, [doc("b", '"b"')], []);
    m.apply(30n, [doc("c", '"c"')], [entry(key(1), "c")]);
    const at = (ts: bigint) => m.scan("t", "i", key(), key(9), ts, 10, false).map((d) => d.id);
    await m.writeIndexEntries([{ ...entry(key(1), "b"), ts: 20n }]);
    expect([at(15n), at(25n), at(35n)]).toEqual([["a"], ["b"], ["c"]]);
    expect(m.auditRowCount().idx).toBe(3);
    await m.writeIndexEntries([{ ...entry(key(1), null), ts: 20n }]); // replaces the entry at 20
    expect([at(15n), at(25n), at(35n)]).toEqual([["a"], [], ["c"]]);
    expect(m.auditRowCount().idx).toBe(3);
    await m.writeIndexEntries([{ ...entry(key(1), "a"), ts: 10n }]); // the oldest place
    expect(at(15n)).toEqual(["a"]);
    expect(m.auditRowCount().idx).toBe(3);
  });

  test("an entry at a ts with no commit is refused", async () => {
    const m = await openLog(null);
    m.apply(10n, [doc("a", '"a"')], []);
    await expect(m.writeIndexEntries([{ ...entry(key(1), "a"), ts: 15n }])).rejects.toThrow(
      "no commit at 15 for an index entry at it",
    );
    await expect(m.writeIndexEntries([{ ...entry(key(1), "a"), ts: 5n }])).rejects.toThrow("no commit at 5");
  });

  test("they are logged, and replayed in place", async () => {
    const path = logPath();
    const m = await openLog(path);
    m.apply(10n, [doc("a", '"a"')], []);
    m.apply(20n, [doc("b", '"b"')], [entry(key(1), "b")]);
    await m.flush();
    await m.writeIndexEntries([{ ...entry(key(1), "a"), ts: 10n }]);
    await m.close();
    const again = await openLog(path);
    expect(again.scan("t", "i", key(), key(9), 15n, 10, false).map((d) => d.id)).toEqual(["a"]);
  });
});
