// The contract subpath of @bunvex/dashboard: the semantics of UI-01 §5.1 as a bun:test suite any DashboardDataSource
// must pass: the mock runs it here, and the server's implementation can run it against a live deployment
// (the idea of PERSIST-01's conformance suite, in small). It needs one table with at least 3 documents.
import { describe, expect, test } from "bun:test";
import {
  type DashboardDataSource,
  DataSourceError,
  type DataSourceErrorCode,
  type Document,
  type DocumentQuery,
  type LogEntry,
  type LogQuery,
  type Page,
} from "./data-source.ts";

export type ContractOptions = {
  /** How long to wait for a watcher's first delivery. Default 5 000 ms. */
  watchTimeoutMs?: number;
};

async function expectError(p: Promise<unknown>, code: DataSourceErrorCode) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DataSourceError);
  expect((e as DataSourceError).code).toBe(code);
}

async function all<T>(fetch: (cursor: string | null) => Promise<Page<T>>, limit = 10_000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < limit; pages++) {
    const p: Page<T> = await fetch(cursor);
    out.push(...p.page);
    if (p.isDone) return out;
    cursor = p.continueCursor;
  }
  throw new Error("pagination did not finish");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function describeDataSourceContract(
  name: string,
  make: () => DashboardDataSource | Promise<DashboardDataSource>,
  opts: ContractOptions = {},
) {
  const watchTimeoutMs = opts.watchTimeoutMs ?? 5000;

  /** The table with the most documents, and its documents walked by creation time, newest first. */
  async function fixture() {
    const src = await make();
    const tables = await src.listTables();
    let best: { name: string; docs: Document[] } | null = null;
    for (const t of tables) {
      const docs = await all((cursor) => src.listDocuments({ table: t.name, numItems: 50, cursor }));
      if (!best || docs.length > best.docs.length) best = { name: t.name, docs };
    }
    if (!best || best.docs.length < 3) throw new Error("the contract suite needs a table with ≥ 3 documents");
    return { src, table: best.name, docs: best.docs };
  }

  describe(`DashboardDataSource contract: ${name}`, () => {
    test("deployment and stats are well-formed", async () => {
      const src = await make();
      const d = await src.getDeployment();
      for (const k of ["name", "version", "persistence"] as const) expect(typeof d[k]).toBe("string");
      const s = await src.getStats();
      for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
    });

    test("tables list their system indexes first", async () => {
      const tables = await (await make()).listTables();
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) {
        expect(t.indexes.slice(0, 2).map((i) => [i.name, i.system])).toEqual([
          ["by_id", true],
          ["by_creation_time", true],
        ]);
        expect(t.indexes.slice(2).every((i) => !i.system)).toBe(true);
      }
    });

    test("pages walk every document once, in order, and end with isDone", async () => {
      const { src, table, docs } = await fixture();
      const ids = docs.map((d) => d._id);
      expect(new Set(ids).size).toBe(ids.length);
      const times = docs.map((d) => d._creationTime);
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const small = await all((cursor) => src.listDocuments({ table, numItems: 2, cursor }));
      expect(small.map((d) => d._id)).toEqual(ids);
      const asc = await all((cursor) => src.listDocuments({ table, numItems: 7, cursor, order: "asc" }));
      expect(asc.map((d) => d._id)).toEqual([...ids].reverse());
    });

    test("every declared index paginates without duplicates or losses", async () => {
      const { src, table, docs } = await fixture();
      const info = (await src.listTables()).find((t) => t.name === table)!;
      for (const ix of info.indexes) {
        const got = await all((cursor) => src.listDocuments({ table, index: ix.name, numItems: 9, cursor }));
        expect(got.map((d) => d._id).sort()).toEqual(docs.map((d) => d._id).sort());
      }
    });

    test("a cursor is only valid for its own query", async () => {
      const { src, table } = await fixture();
      const q: DocumentQuery = { table, numItems: 1, cursor: null };
      const first = await src.listDocuments(q);
      await expectError(src.listDocuments({ ...q, order: "asc", cursor: first.continueCursor }), "invalid_request");
      await expectError(src.listDocuments({ ...q, cursor: "not a cursor" }), "invalid_request");
    });

    test("unknown table → not_found; unknown index or bad numItems → invalid_request", async () => {
      const { src, table } = await fixture();
      await expectError(src.listDocuments({ table: "no_such_table_x", numItems: 5, cursor: null }), "not_found");
      await expectError(src.getDocument("no_such_table_x", "x"), "not_found");
      await expectError(
        src.listDocuments({ table, index: "no_such_index", numItems: 5, cursor: null }),
        "invalid_request",
      );
      await expectError(src.listDocuments({ table, numItems: 0, cursor: null }), "invalid_request");
    });

    test("getDocument returns a listed document, and null for an unknown id", async () => {
      const { src, table, docs } = await fixture();
      const d = docs[1]!;
      expect(await src.getDocument(table, d._id)).toEqual(d);
      expect(await src.getDocument(table, "0000000000000000000000000000zzzz")).toBeNull();
    });

    test("functions have a module:name path and a kind", async () => {
      for (const f of await (await make()).listFunctions()) {
        expect(f.path).toMatch(/^[^:]+:[^:]+$/);
        expect(["query", "mutation", "action"]).toContain(f.kind);
        expect(["public", "internal"]).toContain(f.visibility);
      }
    });

    test("logs page newest first with increasing ids, and respect the filter", async () => {
      const src = await make();
      const pageOf = (q: Omit<LogQuery, "cursor">) => (cursor: string | null) => src.listLogs({ ...q, cursor });
      const first: LogEntry[] = (await src.listLogs({ numItems: 50, cursor: null })).page;
      const ids = first.map((e) => e.id);
      expect(ids).toEqual([...ids].sort().reverse());
      const errors = await all(pageOf({ numItems: 25, levels: ["error"] }), 20).catch(() => []);
      expect(errors.every((e) => e.level === "error")).toBe(true);
      const fn = first.find((e) => e.function)?.function?.path;
      if (fn) {
        const mine = (await src.listLogs({ numItems: 20, cursor: null, function: fn })).page;
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((e) => e.function?.path === fn)).toBe(true);
      }
    });

    test("an aborted call rejects with the signal's AbortError", async () => {
      const src = await make();
      const ac = new AbortController();
      ac.abort();
      const e = await src.listTables({ signal: ac.signal }).catch((err: unknown) => err);
      expect((e as Error).name).toBe("AbortError");
    });

    test("watchStats delivers asynchronously and stops after unsubscribe", async () => {
      const src = await make();
      let calls = 0;
      let failure: DataSourceError | null = null;
      const off = src.watchStats(
        () => calls++,
        (e) => {
          failure = e;
        },
      );
      expect(calls).toBe(0); // never synchronously
      const deadline = performance.now() + watchTimeoutMs;
      while (calls === 0 && failure === null && performance.now() < deadline) await sleep(5);
      off();
      expect(failure).toBeNull();
      expect(calls).toBeGreaterThan(0);
      const before = calls;
      await sleep(50);
      expect(calls).toBe(before);
    });

    test("watchLogs never delivers synchronously nor after unsubscribe", async () => {
      const src = await make();
      let calls = 0;
      const off = src.watchLogs(
        {},
        () => calls++,
        () => {},
      );
      expect(calls).toBe(0);
      off();
      const before = calls;
      await sleep(50);
      expect(calls).toBe(before);
    });
  });
}
