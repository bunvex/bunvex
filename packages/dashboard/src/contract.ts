// The contract subpath of @bunvex/dashboard: the semantics of UI-01 §5.1 and §12.4 as a bun:test suite any
// DashboardDataSource must pass. The mock runs it here; the server's implementation can run it against a
// live deployment (the idea of PERSIST-01's conformance suite, in small). Filters are checked against
// `filters.ts` as the oracle: every expression must return exactly the documents it selects, in index order.
//
// Reads need one table with at least 3 documents. WRITES RUN ONLY when `writes.table` names a table the
// suite may fill and empty — never point it at data you want to keep.
import { test as bunTest, describe, expect } from "bun:test";
import { describeAuthContract } from "./contract-auth.ts";
import { describeAuthAdminContract } from "./contract-auth-admin.ts";
import { describeClientsContract } from "./contract-clients.ts";
import { type DeploymentContractOptions, describeDeploymentContract } from "./contract-deployment.ts";
import { describeMetricsContract } from "./contract-metrics.ts";
import { describeSnapshotContract, type SnapshotContractOptions } from "./contract-snapshot.ts";
import { type DeploymentStateContractOptions, describeDeploymentStateContract } from "./contract-state.ts";
import { describeSubscriptionsContract, expectExecutionLinks } from "./contract-subscriptions.ts";
import { describeSystemTablesContract } from "./contract-system-tables.ts";
import { describeTopologyContract } from "./contract-topology.ts";
import {
  type DashboardDataSource,
  DataSourceError,
  type DataSourceErrorCode,
  type Document,
  type FieldFilter,
  type FilterExpression,
  type FunctionRun,
  type IndexInfo,
  type IndexListEntry,
  type LogEntry,
  OPERATIONS,
  type Page,
  type Value,
} from "./data-source.ts";
import { contractParts } from "./extensions/contract.ts";
import type { ContractExtensionPart } from "./extensions/contract-types.ts";
import { compareValues, DEFAULT_INDEX, fieldValue, matchesFilter } from "./filters.ts";
import { isValidatorJson, validateValue } from "./validators.ts";

export type ContractOptions = DeploymentContractOptions &
  DeploymentStateContractOptions &
  SnapshotContractOptions & {
    /** How long to wait for a watcher's first delivery. Default 5 000 ms. */
    watchTimeoutMs?: number;
    /** Per test. Default 30 000 ms: a live server walks many pages. */
    timeoutMs?: number;
    /** Enables the write tests on this table; `clear: true` also lets the suite empty it. */
    /** The extensions' contract parts (UI-01 §26). Default: the registry's (`src/extensions/contract.ts`). */
    extensions?: readonly ContractExtensionPart[];
    writes?: { table: string; clear?: boolean };
    /**
     * Runs only these areas; the tests of the others are registered as skipped. For a source built in steps
     * (STUDY-149: the server source offers an area once the server functions under it exist). Default: all.
     */
    only?: readonly ContractArea[];
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

/** The areas of the suite, for `ContractOptions.only`: the core's sections, then each part. */
export type ContractArea =
  | "deployment"
  | "tables"
  | "documents"
  | "functions"
  | "logs"
  | "run"
  | "deploymentFeatures"
  | "state"
  | "metrics"
  | "topology"
  | "subscriptions"
  | "systemTables"
  | "clients"
  | "auth"
  | "authAdmin"
  | "snapshot"
  | "extensions"
  | "writes";

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
  /** The area of the tests being registered (registration is synchronous; the parts register when called). */
  let area: ContractArea = "deployment";
  const test = (name: string, fn: () => Promise<void>) =>
    !opts.only || opts.only.includes(area) ? bunTest(name, fn, timeoutMs) : bunTest.skip(name, fn);

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
    area = "tables";
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

    test("watchIndexes, when offered: a table's declared indexes, not by_id or by_creation_time; null for none", async () => {
      const src = await make();
      if (!src.watchIndexes) return;
      const watch = (table: string) =>
        new Promise<IndexListEntry[] | null>((resolve, reject) => {
          let off = () => {};
          off = src.watchIndexes!(
            table,
            (l) => {
              setTimeout(() => off(), 0);
              resolve(l);
            },
            reject,
          );
        });
      for (const t of await src.listTables()) {
        const list = await watch(t.name);
        const names = (list ?? []).map((ix) => ix.name);
        expect(names).not.toContain("by_id");
        expect(names).not.toContain("by_creation_time");
        // every declared database index the grid reads is listed, with its fields (`_creationTime` last)
        for (const ix of t.indexes.filter((i) => !i.system)) {
          const entry = list?.find((e) => e.name === ix.name);
          expect(entry?.fields).toEqual([...ix.fields, "_creationTime"]);
          expect(entry?.backfill.state).toBe(ix.state === "ready" ? "done" : "backfilling");
        }
      }
      expect(await watch("no_such_table_xyz")).toBeNull();
    });

    // -------------------------------------------------------------- pagination
    area = "documents";
    test("a page of more than 32 000 items is refused, as a deployment's paginate refuses it", async () => {
      const { src, table } = await fixture();
      const e = await src.listDocuments({ table, numItems: 32_001, cursor: null }).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e instanceof DataSourceError && e.code === "invalid_request").toBe(true);
      expect((e as Error).message).toContain("Requested too many items: 32001");
      expect((await src.listDocuments({ table, numItems: 32_000, cursor: null })).page.length).toBeGreaterThan(0);
    });

    test("a search index (when a table has one): its word finds the documents; descending and empty as a deployment's", async () => {
      const src = await make();
      const t = (await src.listTables()).find((x) => (x.searchIndexes ?? []).length > 0);
      if (!t) return;
      const ix = t.searchIndexes![0]!;
      const docs = await all((cursor) => src.listDocuments({ table: t.name, numItems: 50, cursor }));
      const text = docs.map((d) => d[ix.searchField]).find((v): v is string => typeof v === "string" && /\w/.test(v));
      if (text === undefined) return;
      const word = text.toLowerCase().match(/[\p{L}\p{N}]+/u)![0];
      const search = (s: string, order: "asc" | "desc" = "asc") =>
        all((cursor) =>
          src.listDocuments({
            table: t.name,
            numItems: 25,
            cursor,
            filter: { clauses: [], order, search: { name: ix.name, search: s, clauses: [] } },
          }),
        );
      const found = await search(word);
      expect(found.length).toBeGreaterThan(0);
      for (const d of found) expect(String(d[ix.searchField]).toLowerCase()).toContain(word);
      // an empty search finds nothing, as a search query does
      expect(await search("")).toEqual([]);
      // by relevance only: descending is refused in Convex's words
      let refused: DataSourceError | undefined;
      try {
        await search(word, "desc");
      } catch (e) {
        refused = e as DataSourceError;
      }
      expect(refused?.code).toBe("invalid_request");
      expect(refused?.message).toBe(`Trying to query search index \`${ix.name}\` in descending order.`);
    });

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
      if (sample) exprs.push(one({ field: sample.field, op: "anyOf", value: [] })); // filters nothing (Convex's)
      if (unsetField) {
        // an unset field is below every value: it passes lt / lte, never gt / gte (Convex's order)
        const set = docs.find((d) => fieldValue(d, unsetField) !== undefined)!;
        const v = fieldValue(set, unsetField)!;
        exprs.push(
          one({ field: unsetField, op: "type", value: "unset" }),
          one({ field: unsetField, op: "notype", value: "unset" }),
          one({ field: unsetField, op: "lt", value: v }),
          one({ field: unsetField, op: "lte", value: v }, "asc"),
          one({ field: unsetField, op: "gte", value: v }),
        );
      }
      // a type clause reads the top-level field by its name, not a dotted path (Convex's)
      const nested = docs
        .flatMap((d) => Object.entries(d))
        .find(
          ([k, x]) =>
            !k.startsWith("_") &&
            x !== null &&
            typeof x === "object" &&
            !Array.isArray(x) &&
            !("$integer" in x) &&
            !("$bytes" in x),
        );
      const inner = nested && Object.keys(nested[1] as object)[0];
      if (nested && inner) exprs.push(one({ field: `${nested[0]}.${inner}`, op: "type", value: "unset" }));
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

    test("inferDocumentType (when present): every document fits it; system fields are left out", async () => {
      const { src, table, docs } = await fixture();
      if (!src.inferDocumentType) return;
      const v = await src.inferDocumentType(table);
      expect(v !== null && isValidatorJson(v)).toBe(true);
      if (v?.type === "object") expect(Object.keys(v.value).some((k) => k.startsWith("_"))).toBe(false);
      for (const d of docs) {
        const own = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("_"))) as Record<string, Value>;
        expect(validateValue(v!, own)).toEqual([]);
      }
      await expectError(src.inferDocumentType("no_such_table"), "not_found");
    });

    test("tableOfId (when present) names a document's table, and null for an unknown id", async () => {
      const { src, table, docs } = await fixture();
      if (!src.tableOfId) return;
      expect(await src.tableOfId(docs[0]!._id)).toBe(table);
      expect(await src.tableOfId("0000000000000000000000000000zzzz")).toBeNull();
      // a file's and a scheduled run's ids, by the names Convex's table mapping gives their tables (STUDY-163 §2)
      const file = (await src.listFiles?.({ numItems: 1, cursor: null }))?.page[0];
      if (file) expect(await src.tableOfId(file.id)).toBe("_file_storage");
      const run = (await src.listScheduledFunctions?.({ numItems: 1, cursor: null }))?.page[0];
      if (run) expect(await src.tableOfId(run.id)).toBe("_scheduled_jobs");
    });

    area = "functions";
    test("functions have a module:name path and a kind; an HTTP action its route and its module", async () => {
      for (const f of await (await make()).listFunctions()) {
        if (f.kind === "httpAction") {
          // Convex's identifier for a route, `METHOD /path`, under the module that routes it
          expect(f.path).toMatch(/^[A-Z]+ \/\S*$/);
          expect(f.module).toMatch(/^[^:]+$/);
          expect(f.visibility).toBe("public");
        } else {
          expect(f.path).toMatch(/^[^:]+:[^:]+$/);
          expect(["query", "mutation", "action"]).toContain(f.kind);
          expect(f.module).toBeUndefined();
        }
        expect(["public", "internal"]).toContain(f.visibility);
        // declared validators come in Convex's JSON form (STUDY-12 V1)
        if (f.args !== undefined) expect(isValidatorJson(f.args)).toBe(true);
        if (f.returns !== undefined) expect(isValidatorJson(f.returns)).toBe(true);
        // the line it is declared on, as Convex's analysis reports it
        if (f.line !== undefined) expect(Number.isInteger(f.line) && f.line > 0).toBe(true);
      }
    });

    area = "logs";
    test("log lines name their execution consistently: a caller is another execution of the same request", async () => {
      const src = await make();
      const page = (await src.listLogs({ numItems: 200, cursor: null })).page;
      const requestOf = new Map<string, string | undefined>();
      for (const e of page) {
        if (e.executionId === undefined) continue;
        expect(e.parentExecutionId).not.toBe(e.executionId);
        const seen = requestOf.get(e.executionId);
        if (seen !== undefined) expect(e.requestId).toBe(seen);
        requestOf.set(e.executionId, e.requestId);
      }
      for (const e of page)
        if (e.parentExecutionId && requestOf.has(e.parentExecutionId))
          expect(requestOf.get(e.parentExecutionId)).toBe(e.requestId);
    });

    test("an execution's usage and identity, when given, are well-formed (STUDY-12 §10.5)", async () => {
      const src = await make();
      const page = (await src.listLogs({ numItems: 200, cursor: null })).page;
      const identities = ["admin", "user", "acting_as_user", "system", "unknown"];
      for (const e of page) {
        const x = e.execution;
        if (!x) continue;
        if (x.identity !== undefined) expect(identities).toContain(x.identity);
        for (const v of Object.values(x.usage ?? {})) {
          expect(typeof v).toBe("number");
          expect(v as number).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test("an execution's links, when given, are well-formed (STUDY-131 AD-27)", async () => {
      const src = await make();
      const page = (await src.listLogs({ numItems: 200, cursor: null })).page;
      expectExecutionLinks(page);
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

    area = "tables";
    test("an aborted call rejects with the signal's AbortError", async () => {
      const src = await make();
      const ac = new AbortController();
      ac.abort();
      const e = await src.listTables({ signal: ac.signal }).catch((err: unknown) => err);
      expect((e as Error).name).toBe("AbortError");
    });

    // -------------------------------------------------------------- watchers
    area = "deployment";
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

    area = "documents";
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
    area = "run";
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

      test("runFunction: an HTTP action, when one is listed, is not run (invalid_request)", async () => {
        const src = await runner();
        const route = (await src.listFunctions()).find((f) => f.kind === "httpAction");
        if (!route) return;
        await expectError(src.runFunction(route.path, {}), "invalid_request");
      });

      test("watchFunction (when present): a query's run arrives, never inside the call; a mutation is invalid_request", async () => {
        const src = await runner();
        if (!src.watchFunction) return;
        const runs: FunctionRun[] = [];
        const errors: DataSourceError[] = [];
        const off = src.watchFunction(
          run.query,
          run.args ?? {},
          (r) => runs.push(r),
          (e) => errors.push(e),
        );
        expect(runs).toEqual([]); // asynchronously
        const deadline = performance.now() + watchTimeoutMs;
        while (runs.length === 0 && errors.length === 0 && performance.now() < deadline) await sleep(5);
        off();
        expect(errors).toEqual([]);
        expect(runs[0]?.error).toBeUndefined();
        expect(runs[0]?.value).not.toBeUndefined();
        const mutation = (await src.listFunctions()).find((f) => f.kind === "mutation");
        if (!mutation) return;
        const refused: DataSourceError[] = [];
        const off2 = src.watchFunction(
          mutation.path,
          {},
          () => {},
          (e) => refused.push(e),
        );
        const until = performance.now() + watchTimeoutMs;
        while (refused.length === 0 && performance.now() < until) await sleep(5);
        off2();
        expect(refused[0]?.code).toBe("invalid_request");
      });

      test("runTestQuery (when present): a query's value and log lines; what it throws, or a module that does not load, is a run", async () => {
        const src = await runner();
        if (!src.runTestQuery) return;
        const ok = await src.runTestQuery(
          'export default query({ handler: async () => { console.log("from the test query"); return 6 * 7; } });',
        );
        expect(ok.error).toBeUndefined();
        expect(ok.value).toBe(42);
        expect(ok.logLines.map((l) => l.message).join("\n")).toContain("from the test query");
        expect(ok.durationMs).toBeGreaterThanOrEqual(0);
        const thrown = await src.runTestQuery(
          'export default query({ handler: async () => { throw new Error("thrown by the test query"); } });',
        );
        expect(thrown.value).toBeUndefined();
        expect(thrown.error?.message).toBeTruthy();
        const broken = await src.runTestQuery("export default query({");
        expect(broken.value).toBeUndefined();
        expect(broken.error?.message).toBeTruthy();
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
    area = "deploymentFeatures";
    describeDeploymentContract({ make, test, watchTimeoutMs, opts });
    area = "state";
    describeDeploymentStateContract({ make, test, opts });
    area = "metrics";
    describeMetricsContract({ make, test });
    area = "topology";
    describeTopologyContract({ make, test, watchTimeoutMs });
    area = "subscriptions";
    describeSubscriptionsContract({ make, test, watchTimeoutMs });
    area = "systemTables";
    describeSystemTablesContract({ make, test });
    area = "clients";
    describeClientsContract({ make, test, writes: !!opts.writes });
    area = "auth";
    describeAuthContract({ make, test });
    area = "authAdmin";
    describeAuthAdminContract({ make, test });
    area = "snapshot";
    describeSnapshotContract({ make, test, opts });
    area = "extensions";
    // each extension's part (UI-01 §26); a part tests only what the source offers
    for (const part of opts.extensions ?? contractParts)
      part.describe({ make, test, watchTimeoutMs, writes: !!opts.writes });

    // -------------------------------------------------------------- writes (opt-in)
    area = "writes";
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

    /** The documents of `table` whose `label` is `label`, oldest first (inserts answer no ids, as Convex's). */
    const labelled = async (src: DashboardDataSource, label: string) =>
      (
        await all((cursor) =>
          src.listDocuments({
            table,
            numItems: 100,
            cursor,
            filter: {
              clauses: [{ id: "label", field: "label", op: "eq", value: label, enabled: true }],
              order: "asc",
            },
          }),
        )
      ).map((d) => d._id);

    test(`writes: insert, patch (set and unset), replace and delete, each seen by watchTable (${table})`, async () => {
      const src = await writer();
      const counts: (number | undefined)[] = [];
      const off = src.watchTable(
        table,
        (c) => counts.push(c.count),
        () => {},
      );
      const label = `contract ${Date.now().toString(36)}`;
      expect(
        await src.insertDocuments(table, [
          { label, n: 1 },
          { label, n: 2 },
        ]),
      ).toBeUndefined();
      const [a, b] = await labelled(src, label);
      expect((await src.getDocument(table, a!))?.n).toBe(1);
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

    test("createTable (when present) makes an empty table outside the schema; a bad name is refused, a taken one not", async () => {
      const src = await make();
      if (!src.createTable) return;
      const name = `contract_${Date.now().toString(36)}`;
      await src.createTable(name);
      const made = (await src.listTables()).find((t) => t.name === name);
      expect(made).toMatchObject({ name, declared: false });
      expect(made?.documentCount ?? 0).toBe(0);
      // Convex's mutation inserts and deletes a document: a taken name is no error (the screen refuses it)
      await src.createTable(name);
      await expectError(src.createTable("_system"), "invalid_request");
      await expectError(src.createTable("9lives"), "invalid_request");
      await expectError(src.createTable("a".repeat(65)), "invalid_request");
      if (src.deleteTables) {
        await src.deleteTables([name]);
        expect((await src.listTables()).some((t) => t.name === name)).toBe(false);
      }
    });

    test(`writes are all or nothing, and say what is wrong (${table})`, async () => {
      const src = await writer();
      const before = await all((cursor) => src.listDocuments({ table, numItems: 100, cursor }));
      await expectError(src.insertDocuments(table, [{ ok: 1 }, { _bad: 2 }]), "invalid_request");
      await expectError(
        src.insertDocuments(
          table,
          Array.from({ length: 4097 }, () => ({})),
        ),
        "invalid_request",
      );
      // a document that is gone: patching, replacing or deleting it fails, and nothing else is written
      const label = `gone ${Date.now().toString(36)}`;
      await src.insertDocuments(table, [{ label }, { label }]);
      const [gone, kept] = await labelled(src, label);
      await src.deleteDocuments(table, [gone!]);
      await expectError(src.patchDocuments(table, [kept!, gone!], { x: 1 }), "not_found");
      await expectError(src.replaceDocument(table, gone!, { x: 1 }), "not_found");
      await expectError(src.deleteDocuments(table, [kept!, gone!]), "not_found");
      expect((await src.getDocument(table, kept!))?.x).toBeUndefined();
      await src.deleteDocuments(table, [kept!]);
      await expectError(
        src.deleteDocuments(
          table,
          Array.from({ length: 4097 }, () => kept!),
        ),
        "invalid_request",
      );
      const after = await all((cursor) => src.listDocuments({ table, numItems: 100, cursor }));
      expect(after.map((d) => d._id)).toEqual(before.map((d) => d._id));
    });

    // as Convex's `db.insert` (STUDY-149 PR 3)
    test("writes: an insert into a table that does not exist creates it", async () => {
      const src = await writer();
      const name = `contract_new_${Date.now().toString(36)}`;
      await src.insertDocuments(name, [{ a: 1 }]);
      expect((await src.listTables()).find((t) => t.name === name)?.documentCount).toBe(1);
      if (src.deleteTables) await src.deleteTables([name]);
    });

    // Convex's bulk edit (`patchDocumentsFields` without ids; STUDY-149 "Bulk edit"), on a table of its own: it
    // touches every document of the table
    test("writes: patchAllDocuments (when present) sets and removes fields in every document, or in none", async () => {
      const src = await writer();
      if (!src.patchAllDocuments) return;
      const name = `contract_bulk_${Date.now().toString(36)}`;
      await src.insertDocuments(name, [{ n: 1, tag: "a" }, { n: 2 }, { n: 3, tag: "c" }]);
      await src.patchAllDocuments(name, { n: 10, tag: { $unset: true }, added: true });
      const docs = await all((cursor) => src.listDocuments({ table: name, numItems: 2, cursor }));
      expect(docs.map(({ _id, _creationTime, ...rest }) => rest)).toEqual([
        { n: 10, added: true },
        { n: 10, added: true },
        { n: 10, added: true },
      ]);
      // one document refused (another `_creationTime`): none is written
      await expectError(src.patchAllDocuments(name, { n: 11, _creationTime: 1 }), "invalid_request");
      expect((await all((cursor) => src.listDocuments({ table: name, numItems: 10, cursor }))).map((d) => d.n)).toEqual(
        [10, 10, 10],
      );
      // nothing to edit in a table that does not exist
      await src.patchAllDocuments(`${name}_none`, { n: 1 });
      if (src.deleteTables) await src.deleteTables([name]);
    });

    if (writes.clear)
      test(`writes: clearTable empties the table (${table})`, async () => {
        const src = await writer();
        await src.insertDocuments(table, [{ label: "to clear" }]);
        const { deleted } = await src.clearTable(table);
        expect(deleted).toBeGreaterThan(0);
        expect((await src.listDocuments({ table, numItems: 10, cursor: null })).page).toEqual([]);
        await expectError(src.clearTable("no_such_table_x"), "not_found");
      });
  });
}
export { expectExecutionLinks };
