// The Data screen's reads (STUDY-149 PR 2): `_system/frontend/getTableMapping`, `paginatedTableDocuments`
// (every filter shape the dashboard sends, its refusals and its shortcuts), `indexes`, `tableSize`, `listById`,
// `getById` and `GET /api/get_indexes`, called as an admin on Convex's backend (the oracle) and on bunvex's, for
// the same documents, compared answer by answer: ids by first appearance, `_creationTime` by rank, cursors as
// opaque. The undefined placeholder is each backend's own (DV-478). Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { creationTimes, errorText, IdMap, normalize } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dashboard-data: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const CONVEX_UNDEFINED =
  "__CONVEX_PLACEHOLDER_undefined_I23atX0jcndVbFgXoQZffsih7eAqktCyFjgUuAeNBtfr3ySOljPSPSEOPFgprkdBO3zXNiGEJxmJ5ZFPc5C5qKesG80QRPvlJe8vgSxAt9feLTwxTg4PHfVwUaTEJU67FDwldWmTxp1guMPwxQ2jOuhEryTBf3mQ";
const BUNVEX_UNDEFINED = CONVEX_UNDEFINED.replace("CONVEX", "BUNVEX");

let convex: Backend;
let bunvex: Backend;
/** Each backend's ids, named by first appearance; each document's name, for building arguments. */
const ids = { convex: new IdMap(), bunvex: new IdMap() };
const byName = { convex: new Map<string, string>(), bunvex: new Map<string, string>() };

const int64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return { $integer: Buffer.from(b).toString("base64") };
};

/** The documents both backends get, in this order (`a` has indexes on `k` and `k, n`; `b` on `x`). */
const DOCS: [string, string, Record<string, unknown>][] = [
  ["a", "a1", { k: 1, n: 10, s: "x" }],
  ["a", "a2", { k: 1, n: 20 }],
  ["a", "a3", { k: 2, n: 5, s: "y" }],
  ["a", "a4", { k: "two", n: null }],
  ["a", "a5", { n: 7, nested: { deep: 1 } }],
  ["a", "a6", { k: int64(3n), n: [1, 2] }],
  ["a", "a7", { k: 2, n: 30, s: "z", b: { $bytes: "AQID" } }],
  ["b", "b1", { x: 1 }],
  ["b", "b2", { x: 2, ref: null }],
];

/** A system query over `/api/query` as an admin (each backend's own scheme), its answer normalised. */
async function system(b: Backend, path: string, args: unknown) {
  const r = await fetch(`${b.url}/api/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  const times = [...creationTimes(body.value)].sort((x, y) => x - y);
  if (body.status === "success") return { status: r.status, value: normalize(body.value, ids[b.name], times) };
  // bunvex words a system function's argument error as a user function's; Convex's system functions check
  // their arguments in JavaScript ("Uncaught Error: …"). A difference of every system function, not of these.
  const message = (body.errorMessage ?? "").replace(/^ArgumentValidationError: /m, "Uncaught Error: ");
  return { status: r.status, error: errorText(message, ids[b.name]) };
}

const both = async <T>(f: (b: Backend) => Promise<T>) => ({ convex: await f(convex), bunvex: await f(bunvex) });
const same = async (what: string, f: (b: Backend) => Promise<unknown>) => {
  const r = await both(f);
  expect({ what, answer: r.bunvex }).toEqual({ what, answer: r.convex });
  return r.convex;
};

/** An answer whose list (`value`, or `value.page`) is in id order, which is random: sorted by `key`. */
function sortedBy(answer: { value?: unknown }, key: string) {
  const sort = (xs: unknown) =>
    Array.isArray(xs) ? [...xs].sort((x, y) => String(x[key]).localeCompare(String(y[key]))) : xs;
  if (Array.isArray(answer.value)) return { ...answer, value: sort(answer.value) };
  const v = answer.value as { page?: unknown } | undefined;
  return v?.page ? { ...answer, value: { ...v, page: sort(v.page) } } : answer;
}

const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64");
/** A `FilterExpression` for one backend: `$undefined` and `@name` (a document's id) resolved for it. */
function filters(b: Backend, expr: unknown): string {
  const resolve = (x: unknown): unknown => {
    if (x === "$undefined") return b.name === "convex" ? CONVEX_UNDEFINED : BUNVEX_UNDEFINED;
    if (typeof x === "string" && x.startsWith("@")) return byName[b.name].get(x.slice(1)) ?? x;
    if (Array.isArray(x)) return x.map(resolve);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, resolve(y)]));
    return x;
  };
  return b64(resolve(expr));
}

const page = (b: Backend, table: string, expr: unknown, numItems = 50, cursor: string | null = null) =>
  system(b, "_system/frontend/paginatedTableDocuments", {
    table,
    filters: expr === null ? null : filters(b, expr),
    paginationOpts: { numItems, cursor },
  });

describe.skipIf(!ready)("the Data screen's reads on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await Promise.all([startConvex(), startBunvex()]);
    for (const b of [convex, bunvex])
      for (const [table, name, doc] of DOCS) {
        const r = await b.call("mutation", "ops:apply", { ops: [{ kind: "insert", table, doc }] });
        if (!r.ok) throw new Error(`${b.name}: ${JSON.stringify(r.body)}`);
        const id = ((r.body as { value: string[] }).value as string[])[0]!;
        ids[b.name].add(id, table);
        byName[b.name].set(name, id);
      }
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("getTableMapping, tableSize and indexes", async () => {
    await same("mapping", (b) => system(b, "_system/frontend/getTableMapping", {}));
    await same("mapping, componentId null", (b) =>
      system(b, "_system/frontend/getTableMapping", { componentId: null }),
    );
    for (const tableName of ["a", "b", "nope", ""])
      await same(`size ${tableName}`, (b) => system(b, "_system/frontend/tableSize", { tableName }));
    // in `_index` id order on both: random ids, so compared by name
    for (const args of [
      { tableName: "a", tableNamespace: null },
      { tableName: "b", tableNamespace: null },
      { tableName: "nope", tableNamespace: null },
      { tableName: null, tableNamespace: null },
      { tableNamespace: null },
      { tableName: "a" },
    ])
      await same(`indexes ${JSON.stringify(args)}`, async (b) =>
        sortedBy(await system(b, "_system/frontend/indexes", args), "name"),
      );
  });

  test("GET /api/get_indexes", async () => {
    await same("get_indexes", async (b) => {
      const r = await fetch(`${b.url}/api/get_indexes`, {
        headers: { authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` },
      });
      const body = (await r.json()) as { indexes?: { table: string; name: string }[] };
      body.indexes?.sort((x, y) => `${x.table}.${x.name}`.localeCompare(`${y.table}.${y.name}`));
      return { status: r.status, body };
    });
    await same("get_indexes without a key", async (b) => (await fetch(`${b.url}/api/get_indexes`)).status);
  });

  test("paginatedTableDocuments: no filters, order, and the pages' cursors", async () => {
    await same("all of a", (b) => page(b, "a", null));
    await same("a, asc", (b) => page(b, "a", { clauses: [], order: "asc" }));
    await same("unknown table", (b) => page(b, "nope", null));
    // a page, then the next one from each backend's own cursor
    await same("two pages", async (b) => {
      const first = await fetch(`${b.url}/api/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
        },
        body: JSON.stringify({
          path: "_system/frontend/paginatedTableDocuments",
          args: { table: "a", filters: null, paginationOpts: { numItems: 3, cursor: null } },
          format: "json",
        }),
      }).then((r) => r.json() as Promise<{ value: { continueCursor: string } }>);
      return [
        await page(b, "a", null, 3),
        await page(b, "a", null, 3, first.value.continueCursor),
        // the cursor of another query
        await page(b, "a", { clauses: [], order: "asc" }, 3, first.value.continueCursor),
      ];
    });
    // bunvex's paginate prefixes the code to this one message (core's cursor.ts; Convex's keybroker does not):
    // a difference of every paginated query, not of this function's
    await same("not a cursor", async (b) => {
      const r = await page(b, "a", null, 3, "not a cursor");
      return r.error !== undefined ? { ...r, error: r.error.replace("InvalidCursor: Failed", "Failed") } : r;
    });
    // bunvex's paginate refuses 0 with the message Convex's JavaScript keeps for a negative number (core's
    // tx.ts; Convex's check is `< 0`, then its backend's): a difference of every paginated query
    await same("numItems 0", async (b) => {
      const r = await page(b, "a", null, 0);
      return r.error !== undefined
        ? {
            ...r,
            error: r.error.replace(
              /`options.numItems` must be .*$/m,
              "Must request at least 1 document while paginating",
            ),
          }
        : r;
    });
  });

  test("paginatedTableDocuments: field filters", async () => {
    const one = (c: Record<string, unknown>, order = "desc") => ({
      clauses: [{ id: "c", enabled: true, ...c }],
      order,
    });
    const cases: [string, unknown][] = [
      ["eq", one({ field: "k", op: "eq", value: 1 })],
      ["neq", one({ field: "k", op: "neq", value: 1 })],
      ["gt", one({ field: "k", op: "gt", value: 1 })],
      ["gte", one({ field: "n", op: "gte", value: 10 }, "asc")],
      ["lt (unset fields too)", one({ field: "k", op: "lt", value: 2 })],
      ["lte", one({ field: "k", op: "lte", value: 1 })],
      ["eq string", one({ field: "s", op: "eq", value: "y" })],
      ["eq int64", one({ field: "k", op: "eq", value: int64(3n) })],
      ["eq bytes", one({ field: "b", op: "eq", value: { $bytes: "AQID" } })],
      ["eq nested", one({ field: "nested.deep", op: "eq", value: 1 })],
      ["eq undefined", one({ field: "k", op: "eq", value: "$undefined" })],
      ["neq undefined", one({ field: "k", op: "neq", value: "$undefined" })],
      ["anyOf", one({ field: "k", op: "anyOf", value: [1, "two"] })],
      ["anyOf with undefined", one({ field: "k", op: "anyOf", value: [2, "$undefined"] })],
      ["anyOf empty", one({ field: "k", op: "anyOf", value: [] })],
      ["noneOf", one({ field: "k", op: "noneOf", value: [1, 2] })],
      ["noneOf empty", one({ field: "k", op: "noneOf", value: [] })],
      ["anyOf int64 (compared as sent)", one({ field: "k", op: "anyOf", value: [int64(3n)] })],
      ["type number", one({ field: "k", op: "type", value: "number" })],
      ["type string", one({ field: "k", op: "type", value: "string" })],
      ["type bigint", one({ field: "k", op: "type", value: "bigint" })],
      ["type unset", one({ field: "k", op: "type", value: "unset" })],
      ["notype unset", one({ field: "k", op: "notype", value: "unset" })],
      ["type null", one({ field: "n", op: "type", value: "null" })],
      ["type array", one({ field: "n", op: "type", value: "array" })],
      ["type object", one({ field: "nested", op: "type", value: "object" })],
      ["type bytes", one({ field: "b", op: "type", value: "bytes" })],
      ["type id", one({ field: "k", op: "type", value: "id" })],
      ["type on a nested field (top-level only)", one({ field: "nested.deep", op: "type", value: "number" })],
      ["disabled", one({ field: "k", op: "eq", value: 1, enabled: false })],
      ["no field", { clauses: [{ op: "eq", value: 1 }], order: "desc" }],
      [
        "two clauses",
        {
          clauses: [
            { field: "k", op: "gte", value: 1, enabled: true },
            { field: "n", op: "lt", value: 25, enabled: true },
          ],
          order: "asc",
        },
      ],
      ["_id eq (a get)", one({ field: "_id", op: "eq", value: "@a3" })],
      ["_id eq another table's id", one({ field: "_id", op: "eq", value: "@b1" })],
      ["_id eq not an id", one({ field: "_id", op: "eq", value: "nope" })],
      ["_id eq a number", one({ field: "_id", op: "eq", value: 5 })],
      ["_creationTime gt 0", one({ field: "_creationTime", op: "gt", value: 0 })],
    ];
    for (const [what, expr] of cases) await same(what, (b) => page(b, "a", expr));
  });

  test("paginatedTableDocuments: index filters", async () => {
    const ix = (name: string, clauses: unknown[], order = "asc", more: unknown[] = []) => ({
      clauses: more,
      order,
      index: { name, clauses },
    });
    const eq = (value: unknown, enabled = true) => ({ type: "indexEq", enabled, value });
    const range = (r: Record<string, unknown>, enabled = true) => ({ type: "indexRange", enabled, ...r });
    const cases: [string, unknown][] = [
      ["by_k eq", ix("by_k", [eq(1)])],
      ["by_k eq desc", ix("by_k", [eq(2)], "desc")],
      ["by_k no clauses", ix("by_k", [])],
      ["by_k disabled clause", ix("by_k", [eq(1, false)])],
      ["by_k eq undefined", ix("by_k", [eq("$undefined")])],
      [
        "by_k_n eq, range",
        ix("by_k_n", [eq(1), range({ lowerOp: "gt", lowerValue: 10, upperOp: "lte", upperValue: 20 })]),
      ],
      ["by_k range", ix("by_k", [range({ lowerOp: "gte", lowerValue: 1, upperOp: "lt", upperValue: 3 })])],
      ["by_k int64", ix("by_k", [eq(int64(3n))])],
      ["by_creation_time", ix("by_creation_time", [], "desc")],
      ["by_creation_time range", ix("by_creation_time", [range({ lowerOp: "gt", lowerValue: 0 })])],
      ["by_id", ix("by_id", [])],
      ["by_id eq", ix("by_id", [eq("@a2")])],
      ["by_k and a field filter", ix("by_k", [eq(2)], "asc", [{ field: "n", op: "gt", value: 5, enabled: true }])],
      ["by_k and _id eq", ix("by_k", [eq(2)], "asc", [{ field: "_id", op: "eq", value: "@a3", enabled: true }])],
      ["unknown index", ix("by_nope", [])],
      ["too many clauses", ix("by_k", [eq(1), eq(2)])],
      ["enabled after disabled", ix("by_k_n", [eq(1, false), eq(2)])],
      ["range before eq", ix("by_k_n", [range({ lowerOp: "gt", lowerValue: 0 }), eq(2)])],
      [
        "a database index as a search index",
        { clauses: [], order: "asc", index: { name: "by_k", search: "x", clauses: [] } },
      ],
    ];
    for (const [what, expr] of cases)
      await same(what, async (b) =>
        what.startsWith("by_id") ? sortedBy(await page(b, "a", expr), "_id") : page(b, "a", expr),
      );
  });

  test("paginatedTableDocuments: refused expressions", async () => {
    const cases: [string, unknown][] = [
      ["a bad value", { clauses: [{ field: "k", op: "eq", value: { $integer: "x" }, enabled: true }] }],
      ["a $ field", { clauses: [{ field: "k", op: "eq", value: { $nope: 1 }, enabled: true }] }],
      ["a disabled bad value", { clauses: [{ field: "k", op: "eq", value: { $nope: 1 }, enabled: false }] }],
      ["no value", { clauses: [{ field: "k", op: "eq", enabled: true }] }],
    ];
    for (const [what, expr] of cases) await same(what, (b) => page(b, "a", expr));
    // the shape's own refusals (zod's in Convex, bunvex's words): both fail
    for (const expr of [
      { clauses: [{ field: "k", op: "like", value: 1 }] },
      { clauses: [{ field: "k", op: "anyOf", value: 1 }] },
      { clauses: [{ field: "k", op: "type", value: "colour" }] },
      { clauses: "x" },
      { clauses: [], order: "up" },
    ]) {
      const r = await both((b) => page(b, "a", expr));
      expect({ expr, bunvex: "error" in r.bunvex, convex: "error" in r.convex }).toEqual({
        expr,
        bunvex: true,
        convex: true,
      });
    }
  });

  test("listById and getById", async () => {
    const list = (b: Backend, items: [string, string][]) =>
      system(b, "_system/frontend/listById", {
        ids: items.map(([name, tableName]) => ({ id: byName[b.name].get(name) ?? name, tableName })),
      });
    await same("listById", (b) =>
      list(b, [
        ["a1", "a"],
        ["b2", "b"],
        ["a1", "b"],
        ["nope", "a"],
        ["a1", "nope"],
        ["a1", "_file_storage"],
        ["a1", "_scheduled_jobs"],
      ]),
    );
    for (const name of ["a2", "b1", "nope"])
      await same(`getById ${name}`, (b) =>
        system(b, "_system/frontend/getById", { id: byName[b.name].get(name) ?? name }),
      );
  });
});
