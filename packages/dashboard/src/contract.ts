// The contract subpath of @bunvex/dashboard: the semantics of UI-01 §5.1 and §12.4 as a bun:test suite any
// DashboardDataSource must pass. The mock runs it here; the server's implementation can run it against a
// live deployment (the idea of PERSIST-01's conformance suite, in small). Filters are checked against
// `filters.ts` as the oracle: every expression must return exactly the documents it selects, in index order.
//
// Reads need one table with at least 3 documents. WRITES RUN ONLY when `writes.table` names a table the
// suite may fill and empty — never point it at data you want to keep.
import { test as bunTest, describe, expect } from "bun:test";
import { type DeploymentContractOptions, describeDeploymentContract } from "./contract-deployment.ts";
import {
  type DashboardDataSource,
  DataSourceError,
  type DataSourceErrorCode,
  type Document,
  type FieldFilter,
  type FilterExpression,
  type IndexInfo,
  type LogEntry,
  OPERATIONS,
  type Page,
  type Value,
} from "./data-source.ts";
import { compareValues, DEFAULT_INDEX, fieldValue, matchesFilter } from "./filters.ts";
import { isValidatorJson } from "./validators.ts";

export type ContractOptions = DeploymentContractOptions & {
  /** How long to wait for a watcher's first delivery. Default 5 000 ms. */
  watchTimeoutMs?: number;
  /** Per test. Default 30 000 ms: a live server walks many pages. */
  timeoutMs?: number;
  /** Enables the write tests on this table; `clear: true` also lets the suite empty it. */
  writes?: { table: string; clear?: boolean };
  /**
   * Enables the runFunction tests with this function: a query that is safe to run (and its arguments),
   * which returns without throwing.
   */
  run?: {
    query: string;
    args?: Record<string, Value>;
    /** Arguments that do not fit the query's declared arguments validator (enables that test; STUDY-12 V1). */
    misfitArgs?: Record<string, Value>;
  };
};

async function expectError(p: Promise<unknown>, code: DataSourceErrorCode, clause?: string) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DataSourceError);
  expect((e as DataSourceError).code).toBe(code);
  if (clause !== undefined) expect((e as DataSourceError).details.clause).toBe(clause);
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

/** What an expression must return, computed from every document of the table. */
function oracle(docs: Document[], expr: FilterExpression, ix: IndexInfo): string[] {
  const fields = ix.name === "by_id" ? ["_id"] : ix.fields;
  const key = (d: Document): Value[] =>
    ix.name === "by_id" ? [d._id] : [...fields.map((f) => fieldValue(d, f) ?? null), d._id];
  const sign = expr.order === "asc" ? 1 : -1;
  return docs
    .filter((d) => matchesFilter(d, expr, ix))
    .sort((a, b) => sign * compareValues(key(a), key(b)))
    .map((d) => d._id);
}

/** A field most documents have, with a scalar value, and its values. */
function sampleField(docs: Document[]): { field: string; values: Value[] } | null {
  const seen = new Map<string, Value[]>();
  for (const d of docs)
    for (const [k, v] of Object.entries(d))
      if (!k.startsWith("_") && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
        seen.set(k, [...(seen.get(k) ?? []), v]);
  const best = [...seen.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return best ? { field: best[0], values: best[1] } : null;
}

export function describeDataSourceContract(
  name: string,
  make: () => DashboardDataSource | Promise<DashboardDataSource>,
  opts: ContractOptions = {},
) {
  const watchTimeoutMs = opts.watchTimeoutMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const test = (name: string, fn: () => Promise<void>) => bunTest(name, fn, timeoutMs);

  /** The table with the most documents, all its documents, and its indexes. */
  async function fixture() {
    const src = await make();
    const tables = await src.listTables();
    let best: { name: string; docs: Document[]; indexes: IndexInfo[] } | null = null;
    for (const t of tables) {
      const docs = await all((cursor) => src.listDocuments({ table: t.name, numItems: 50, cursor }));
      if (!best || docs.length > best.docs.length) best = { name: t.name, docs, indexes: t.indexes };
    }
    if (!best || best.docs.length < 3) throw new Error("the contract suite needs a table with ≥ 3 documents");
    return { src, table: best.name, docs: best.docs, indexes: best.indexes };
  }

  describe(`DashboardDataSource contract: ${name}`, () => {
    // -------------------------------------------------------------- deployment
    test("deployment, capabilities and stats are well-formed", async () => {
      const src = await make();
      const d = await src.getDeployment();
      for (const k of ["name", "version", "persistence"] as const) expect(typeof d[k]).toBe("string");
      const c = await src.getCapabilities();
      expect(typeof c.readOnly).toBe("boolean");
      for (const op of c.operations) expect(OPERATIONS).toContain(op);
      const s = await src.getStats();
      for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
    });

    // -------------------------------------------------------------- tables and schema
    test("tables list their system indexes first, and say whether the schema declares them", async () => {
      const src = await make();
      const tables = await src.listTables();
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) {
        expect(t.indexes.slice(0, 2).map((i) => [i.name, i.system, i.state])).toEqual([
          ["by_id", true, "ready"],
          ["by_creation_time", true, "ready"],
        ]);
        expect(t.indexes.slice(2).every((i) => !i.system)).toBe(true);
        expect(typeof t.declared).toBe("boolean");
      }
      const schema = await src.getSchema();
      const declared = tables.filter((t) => t.declared).map((t) => t.name);
      expect(schema.tables.map((t) => t.name).sort()).toEqual(declared.sort());
      // a declared document type comes in Convex's JSON form, without the system fields (STUDY-12 V2)
      for (const t of schema.tables) {
        if (t.validator === undefined) continue;
        expect(isValidatorJson(t.validator)).toBe(true);
        if (t.validator.type === "object")
          expect(Object.keys(t.validator.value).some((k) => k.startsWith("_"))).toBe(false);
      }
    });

    // -------------------------------------------------------------- pagination
    test("pages walk every document once, newest first by default, and end with isDone", async () => {
      const { src, table, docs } = await fixture();
      const ids = docs.map((d) => d._id);
      expect(new Set(ids).size).toBe(ids.length);
      const times = docs.map((d) => d._creationTime);
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const small = await all((cursor) => src.listDocuments({ table, numItems: 2, cursor }));
      expect(small.map((d) => d._id)).toEqual(ids);
      const asc = await all((cursor) =>
        src.listDocuments({ table, numItems: 7, cursor, filter: { clauses: [], order: "asc" } }),
      );
      expect(asc.map((d) => d._id)).toEqual([...ids].reverse());
    });

    test("every ready index walks the table in its order, without duplicates or losses", async () => {
      const { src, table, docs, indexes } = await fixture();
      for (const ix of indexes.filter((i) => i.state === "ready")) {
        const filter: FilterExpression = { index: { name: ix.name, eq: [] }, clauses: [], order: "asc" };
        const got = await all((cursor) => src.listDocuments({ table, numItems: 9, cursor, filter }));
        expect({ index: ix.name, ids: got.map((d) => d._id) }).toEqual({
          index: ix.name,
          ids: oracle(docs, filter, ix),
        });
      }
    });

    test("a cursor is only valid for its own query", async () => {
      const { src, table } = await fixture();
      const first = await src.listDocuments({ table, numItems: 1, cursor: null });
      await expectError(
        src.listDocuments({ table, numItems: 1, cursor: first.continueCursor, filter: { clauses: [], order: "asc" } }),
        "invalid_request",
      );
      await expectError(src.listDocuments({ table, numItems: 1, cursor: "not a cursor" }), "invalid_request");
    });

    // -------------------------------------------------------------- filters
    test("field filters select exactly what they say, in index order", async () => {
      const { src, table, docs, indexes } = await fixture();
      const byTime = indexes.find((i) => i.name === DEFAULT_INDEX)!;
      const sample = sampleField(docs);
      const times = docs.map((d) => d._creationTime).sort((a, b) => a - b);
      const mid = times[Math.floor(times.length / 2)]!;
      const unsetField = [...new Set(docs.flatMap((d) => Object.keys(d)))].find(
        (k) => !k.startsWith("_") && docs.some((d) => !(k in d)),
      );
      const one = (c: Omit<FieldFilter, "id" | "enabled">, order: "asc" | "desc" = "desc", enabled = true) => ({
        clauses: [{ id: "c", enabled, ...c }],
        order,
      });
      const exprs: FilterExpression[] = [
        one({ field: "_creationTime", op: "gt", value: mid }),
        one({ field: "_creationTime", op: "lte", value: mid }, "asc"),
        one({ field: "_creationTime", op: "gt", value: mid }, "desc", false), // disabled: ignored
      ];
      if (sample) {
        const field = sample.field;
        const [v1, v2] = [sample.values[0]!, sample.values.at(-1)!];
        const t = typeof v1 === "string" ? "string" : typeof v1 === "number" ? "number" : "boolean";
        exprs.push(
          one({ field, op: "eq", value: v1 }),
          one({ field, op: "neq", value: v1 }),
          one({ field, op: "gte", value: v1 }),
          one({ field, op: "lt", value: v1 }),
          one({ field, op: "anyOf", value: [v1, v2] }),
          one({ field, op: "noneOf", value: [v1] }),
          one({ field, op: "type", value: t }),
          one({ field, op: "notype", value: "null" }),
          {
            clauses: [
              { id: "x", field, op: "neq", value: v1, enabled: true },
              { id: "y", field: "_creationTime", op: "gte", value: mid, enabled: true },
            ],
            order: "asc",
          },
        );
      }
      if (unsetField)
        exprs.push(
          one({ field: unsetField, op: "type", value: "unset" }),
          one({ field: unsetField, op: "notype", value: "unset" }),
        );
      for (const filter of exprs) {
        const got = await all((cursor) => src.listDocuments({ table, numItems: 6, cursor, filter }));
        expect({ filter, ids: got.map((d) => d._id) }).toEqual({ filter, ids: oracle(docs, filter, byTime) });
      }
    });

    test("index filters read a prefix of the index, then a range on the next field", async () => {
      const { src, table, docs, indexes } = await fixture();
      const byTime = indexes.find((i) => i.name === DEFAULT_INDEX)!;
      const times = docs.map((d) => d._creationTime).sort((a, b) => a - b);
      const range: FilterExpression = {
        index: {
          name: DEFAULT_INDEX,
          eq: [],
          range: { lower: { op: "gte", value: times[1]! }, upper: { op: "lt", value: times.at(-2)! } },
        },
        clauses: [],
        order: "asc",
      };
      const got = await all((cursor) => src.listDocuments({ table, numItems: 5, cursor, filter: range }));
      expect(got.map((d) => d._id)).toEqual(oracle(docs, range, byTime));
      // an eq on the first field of a declared index, with the value one of the documents has
      const declared = indexes.find((i) => !i.system && i.state === "ready" && i.fields.length > 0);
      const withValue = declared && docs.find((d) => fieldValue(d, declared.fields[0]!) !== undefined);
      if (declared && withValue) {
        const eq: FilterExpression = {
          index: { name: declared.name, eq: [{ value: fieldValue(withValue, declared.fields[0]!)!, enabled: true }] },
          clauses: [],
          order: "desc",
        };
        const byEq = await all((cursor) => src.listDocuments({ table, numItems: 4, cursor, filter: eq }));
        expect(byEq.length).toBeGreaterThan(0);
        expect(byEq.map((d) => d._id)).toEqual(oracle(docs, eq, declared));
      }
    });

    test("invalid requests are rejected and name the clause at fault", async () => {
      const { src, table, indexes } = await fixture();
      const q = (filter: FilterExpression) => src.listDocuments({ table, numItems: 5, cursor: null, filter });
      await expectError(src.listDocuments({ table: "no_such_table_x", numItems: 5, cursor: null }), "not_found");
      await expectError(src.getDocument("no_such_table_x", "x"), "not_found");
      await expectError(src.listDocuments({ table, numItems: 0, cursor: null }), "invalid_request");
      await expectError(
        q({ index: { name: "no_such_index", eq: [] }, clauses: [], order: "asc" }),
        "invalid_request",
        "index",
      );
      await expectError(
        q({
          index: {
            name: DEFAULT_INDEX,
            eq: [
              { value: 1, enabled: true },
              { value: 2, enabled: true },
            ],
          },
          clauses: [],
          order: "asc",
        }),
        "invalid_request",
        "index",
      );
      await expectError(
        q({ clauses: [{ id: "bad", field: "x", op: "anyOf", value: "not a list", enabled: true }], order: "asc" }),
        "invalid_request",
        "bad",
      );
      await expectError(
        q({ clauses: [{ id: "t", field: "x", op: "type", value: "colour" as never, enabled: true }], order: "asc" }),
        "invalid_request",
        "t",
      );
      const backfilling = indexes.find((i) => i.state === "backfilling");
      if (backfilling)
        await expectError(
          q({ index: { name: backfilling.name, eq: [] }, clauses: [], order: "asc" }),
          "invalid_request",
          "index",
        );
    });

    // -------------------------------------------------------------- documents, functions, logs
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
        // declared validators come in Convex's JSON form (STUDY-12 V1)
        if (f.args !== undefined) expect(isValidatorJson(f.args)).toBe(true);
        if (f.returns !== undefined) expect(isValidatorJson(f.returns)).toBe(true);
      }
    });

    test("logs page newest first with increasing ids, and respect the filter", async () => {
      const src = await make();
      const first: LogEntry[] = (await src.listLogs({ numItems: 50, cursor: null })).page;
      const ids = first.map((e) => e.id);
      expect(ids).toEqual([...ids].sort().reverse());
      const errors = await all((cursor) => src.listLogs({ numItems: 25, cursor, levels: ["error"] }), 20).catch(
        () => [],
      );
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

    // -------------------------------------------------------------- watchers
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

    test("watchLogs and watchTable never deliver synchronously nor after unsubscribe", async () => {
      const { src, table } = await fixture();
      let calls = 0;
      const offLogs = src.watchLogs(
        {},
        () => calls++,
        () => {},
      );
      const offTable = src.watchTable(
        table,
        () => calls++,
        () => {},
      );
      expect(calls).toBe(0);
      offLogs();
      offTable();
      const before = calls;
      await sleep(50);
      expect(calls).toBe(before);
    });

    test("watchTable on an unknown table reports not_found, asynchronously", async () => {
      const src = await make();
      let error: DataSourceError | null = null;
      const off = src.watchTable(
        "no_such_table_x",
        () => {},
        (e) => {
          error = e;
        },
      );
      expect(error).toBeNull();
      const deadline = performance.now() + watchTimeoutMs;
      while (error === null && performance.now() < deadline) await sleep(5);
      off();
      expect((error as DataSourceError | null)?.code).toBe("not_found");
    });

    // -------------------------------------------------------------- running functions (opt-in)
    const run = opts.run;
    if (run) {
      const runner = async () => {
        const src = await make();
        if (!src.runFunction) throw new Error("run was enabled but the source has no runFunction");
        if (!(await src.getCapabilities()).operations.includes("runFunctions"))
          throw new Error("run was enabled but the source does not grant runFunctions");
        return src as DashboardDataSource & Required<Pick<DashboardDataSource, "runFunction">>;
      };

      test(`runFunction: a query returns its value and its log lines, and is logged (${run.query})`, async () => {
        const src = await runner();
        const logged: LogEntry[] = [];
        const off = src.watchLogs(
          { function: run.query },
          (e) => logged.push(...e),
          () => {},
        );
        const r = await src.runFunction(run.query, run.args ?? {});
        expect(r.error).toBeUndefined();
        expect(r.value).not.toBeUndefined();
        expect(Array.isArray(r.logLines)).toBe(true);
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
        const deadline = performance.now() + watchTimeoutMs;
        while (!logged.some((e) => e.execution) && performance.now() < deadline) await sleep(5);
        off();
        expect(logged.some((e) => e.execution?.status === "success")).toBe(true);
      });

      test("runFunction: an unknown function is not_found", async () => {
        const src = await runner();
        await expectError(src.runFunction("no_such_module:nothing", {}), "not_found");
      });

      const misfit = run.misfitArgs;
      if (misfit)
        test("runFunction: arguments that do not fit the declared validator fail the run, not the call", async () => {
          const src = await runner();
          const fn = (await src.listFunctions()).find((f) => f.path === run.query);
          expect(fn?.args).toBeDefined();
          const r = await src.runFunction(run.query, misfit);
          expect(r.value).toBeUndefined();
          expect(r.error?.message).toMatch(/ArgumentValidationError/);
        });
    }

    // -------------------------------------------------------------- the deployment's other features (§14)
    describeDeploymentContract({ make, test, watchTimeoutMs, opts });

    // -------------------------------------------------------------- writes (opt-in)
    const writes = opts.writes;
    if (!writes) return;
    const { table } = writes;
    const writer = async () => {
      const src = await make();
      if (!src.insertDocuments || !src.patchDocuments || !src.replaceDocument || !src.deleteDocuments)
        throw new Error("writes were enabled but the source has no write methods");
      const caps = await src.getCapabilities();
      if (caps.readOnly || !caps.operations.includes("writeData"))
        throw new Error("writes were enabled but the source does not grant writeData");
      return src as Required<DashboardDataSource>;
    };

    test(`writes: insert, patch (set and unset), replace and delete, each seen by watchTable (${table})`, async () => {
      const src = await writer();
      const counts: (number | undefined)[] = [];
      const off = src.watchTable(
        table,
        (c) => counts.push(c.count),
        () => {},
      );
      const [a, b] = await src.insertDocuments(table, [
        { label: "contract a", n: 1 },
        { label: "contract b", n: 2 },
      ]);
      expect((await src.getDocument(table, a!))?.label).toBe("contract a");
      await src.patchDocuments(table, [a!, b!], { n: 10, tag: "patched" });
      await src.patchDocuments(table, [b!], { tag: { $unset: true } });
      const pa = await src.getDocument(table, a!);
      const pb = await src.getDocument(table, b!);
      expect([pa?.n, pa?.tag, pb?.n, "tag" in (pb ?? {})]).toEqual([10, "patched", 10, false]);
      await src.replaceDocument(table, a!, { label: "replaced" });
      expect(await src.getDocument(table, a!)).toEqual({
        _id: a!,
        _creationTime: pa!._creationTime,
        label: "replaced",
      });
      await src.deleteDocuments(table, [a!, b!]);
      expect(await src.getDocument(table, a!)).toBeNull();
      const deadline = performance.now() + watchTimeoutMs;
      while (counts.length === 0 && performance.now() < deadline) await sleep(5);
      off();
      expect(counts.length).toBeGreaterThan(0);
    });

    test(`writes are all or nothing, and say what is wrong (${table})`, async () => {
      const src = await writer();
      const before = await all((cursor) => src.listDocuments({ table, numItems: 100, cursor }));
      await expectError(src.insertDocuments(table, [{ ok: 1 }, { _bad: 2 }]), "invalid_request");
      await expectError(src.patchDocuments(table, ["0000000000000000000000000000zzzz"], { x: 1 }), "not_found");
      await expectError(src.insertDocuments("no_such_table_x", [{ a: 1 }]), "not_found");
      const after = await all((cursor) => src.listDocuments({ table, numItems: 100, cursor }));
      expect(after.map((d) => d._id)).toEqual(before.map((d) => d._id));
    });

    if (writes.clear)
      test(`writes: clearTable empties the table (${table})`, async () => {
        const src = await writer();
        await src.insertDocuments(table, [{ label: "to clear" }]);
        const { deleted } = await src.clearTable(table);
        expect(deleted).toBeGreaterThan(0);
        expect((await src.listDocuments({ table, numItems: 10, cursor: null })).page).toEqual([]);
      });
  });
}
