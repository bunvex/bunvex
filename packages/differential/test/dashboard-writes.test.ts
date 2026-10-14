// The Data screen's writes (STUDY-149 PR 3): `_system/frontend/addDocument`, `patchDocumentsFields`,
// `replaceDocument`, `deleteDocuments`, `clearTablePage` and `createTable`, called as an admin on Convex's backend
// (the oracle) and on bunvex's with the same arguments, in the same order, for the app of `dashboard-writes-app/`
// (a table of any documents, one with a strict document type). Every answer, the data left in each table and the
// audit events the calls recorded are compared, ids named by first appearance and times left out. The undefined
// placeholder is each backend's own (DV-478), the application error's name too (DV-03). Local only: skipped, with
// a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
//
// Left out, as differences of `db.insert` / `db.patch` / `db.query` in every function, not of these (STUDY-149
// "PR 3, as built"): a table name that is not an identifier and a document that is not an object (bunvex's own
// words), a missing required field's display (bunvex shows the system fields), a `_creationTime` patch's
// display, `by_creation_time` on a table that does not exist (Convex: "Index … not found."), and a `$` field
// name in the arguments (refused before the function on bunvex).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dashboard-writes: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../dashboard-writes-app");
const CONVEX_UNDEFINED =
  "__CONVEX_PLACEHOLDER_undefined_I23atX0jcndVbFgXoQZffsih7eAqktCyFjgUuAeNBtfr3ySOljPSPSEOPFgprkdBO3zXNiGEJxmJ5ZFPc5C5qKesG80QRPvlJe8vgSxAt9feLTwxTg4PHfVwUaTEJU67FDwldWmTxp1guMPwxQ2jOuhEryTBf3mQ";
const BUNVEX_UNDEFINED = CONVEX_UNDEFINED.replace("CONVEX", "BUNVEX");
const DATA_ACTIONS = ["add_documents", "update_documents", "delete_documents", "create_table"];

let convex: Backend;
let bunvex: Backend;

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

/** A function over the HTTP API (as an admin unless `key` is ""), its value or its error and data. */
async function call(b: Backend, kind: "query" | "mutation", path: string, args: unknown, key = authOf(b)) {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key && { authorization: key }) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string; errorData?: unknown };
  if (body.status === "success") return { value: body.value };
  return {
    error: errorText(body.errorMessage ?? ""),
    ...(body.errorData !== undefined && { data: errorText(String(body.errorData)) }),
  };
}
const m = (b: Backend, name: string, args: unknown) => call(b, "mutation", `_system/frontend/${name}`, args);
const dump = async (b: Backend, table: string) =>
  ((await call(b, "query", "ops:dump", { table })) as { value: Record<string, unknown>[] }).value;
const idsOf = async (b: Backend, table: string) => (await dump(b, table)).map((d) => d._id as string);

/**
 * Ids named by first appearance (in values and in messages), times and cursors left out; Convex's placeholder
 * and bunvex's are the same word.
 */
function normalize(value: unknown): unknown {
  const names = new Map<string, string>();
  const idName = (s: string) => {
    if (!names.has(s)) names.set(s, `id${names.size}`);
    return names.get(s)!;
  };
  const walk = (v: unknown, key = ""): unknown => {
    if (key === "_creationTime") return "<time>";
    if (key === "continueCursor") return "<cursor>";
    if (typeof v === "string")
      return v
        .replace(BUNVEX_UNDEFINED, "<undefined>")
        .replace(CONVEX_UNDEFINED, "<undefined>")
        .replace(/\b[0-9a-hjkmnp-tv-z]{31,37}\b/g, idName)
        .replace(/creation time \d+(\.\d+)?/g, "creation time <time>");
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

/** Runs `script` on both backends, each from a fresh table state, and compares what it recorded. */
async function same(script: (b: Backend, record: (what: string, x: unknown) => void) => Promise<void>) {
  const run = async (b: Backend) => {
    const out: [string, unknown][] = [];
    await script(b, (what, x) => out.push([what, x]));
    return normalize(out);
  };
  const [c, x] = [await run(convex), await run(bunvex)];
  expect(x).toEqual(c);
}

/** The data events since the last call (newest first), as each backend recorded them. */
async function eventsSince(b: Backend, since: number) {
  const r = (await call(b, "query", "_system/frontend/paginatedDeploymentEvents", {
    paginationOpts: { numItems: 200, cursor: null },
    filters: { minDate: since },
  })) as { value: { page: Record<string, unknown>[] } };
  return r.value.page
    .filter((e) => DATA_ACTIONS.includes(e.action as string))
    .map((e) => ({ action: e.action, metadata: e.metadata, member_id: e.member_id }));
}

describe.skipIf(!ready)("the Data screen's writes on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("addDocument: inserts, the limit, every refusal, a new table; one event per call with the ids", async () => {
    await same(async (b, rec) => {
      const since = Date.now() - 1;
      rec("three", await m(b, "addDocument", { table: "free", documents: [{ k: 1 }, { k: 2 }, { k: 3 }] }));
      rec("none", await m(b, "addDocument", { table: "free", documents: [] }));
      rec("a bad field", await m(b, "addDocument", { table: "free", documents: [{ ok: 1 }, { _bad: 2 }] }));
      rec(
        "an _id of another",
        await m(b, "addDocument", { table: "free", documents: [{ _id: (await idsOf(b, "free"))[0] }] }),
      );
      rec("a new table", await m(b, "addDocument", { table: "brandnew", documents: [{ z: 1 }] }));
      rec("the schema", await m(b, "addDocument", { table: "strict", documents: [{ name: "ok" }, { name: 1 }] }));
      rec("a system table", await m(b, "addDocument", { table: "_storage", documents: [{}] }));
      rec("a _ table", await m(b, "addDocument", { table: "_foo", documents: [{}] }));
      rec("4097", await m(b, "addDocument", { table: "free", documents: Array.from({ length: 4097 }, () => ({})) }));
      rec("no table", await m(b, "addDocument", { documents: [] }));
      rec("componentId null", await m(b, "addDocument", { table: "free", documents: [{ k: 4 }], componentId: null }));
      rec("free", await dump(b, "free"));
      rec("strict", await dump(b, "strict"));
      rec("brandnew", await dump(b, "brandnew"));
      rec("events", await eventsSince(b, since));
    });
  });

  test("patchDocumentsFields: set, remove, every document, system fields, ids that are gone or not ids", async () => {
    await same(async (b, rec) => {
      const placeholder = b.name === "convex" ? CONVEX_UNDEFINED : BUNVEX_UNDEFINED;
      await m(b, "addDocument", { table: "pfree", documents: [{ k: 1 }, { k: 2 }, { k: 3 }] });
      const [a, bb, c] = await idsOf(b, "pfree");
      const since = Date.now() - 1;
      const patch = (args: Record<string, unknown>) => m(b, "patchDocumentsFields", { table: "pfree", ...args });
      rec("set", await patch({ ids: [a], fields: { n: 5, s: "x" } }));
      rec("remove", await patch({ ids: [a], fields: { s: placeholder } }));
      rec("its _id", await patch({ ids: [a], fields: { _id: a } }));
      rec("another _id", await patch({ ids: [a], fields: { _id: bb } }));
      rec("not an id", await patch({ ids: ["0000000000000000000000000000zzzz"], fields: { x: 1 } }));
      rec("every document", await patch({ fields: { all: true } }));
      rec("fields not an object", await patch({ ids: [a], fields: 5 }));
      rec("no ids", await patch({ ids: [], fields: { x: 1 } }));
      await m(b, "deleteDocuments", { toDelete: [{ id: c, tableName: "pfree" }] });
      rec("one gone", await patch({ ids: [bb, c], fields: { x: 1 } }));
      rec(
        "another table's name",
        await m(b, "patchDocumentsFields", { table: "elsewhere", ids: [bb], fields: { y: 1 } }),
      );
      rec("strict", await m(b, "addDocument", { table: "strict", documents: [{ name: "s" }] }));
      const [s] = await idsOf(b, "strict");
      rec("the schema", await m(b, "patchDocumentsFields", { table: "strict", ids: [s], fields: { name: 1 } }));
      rec("pfree", await dump(b, "pfree"));
      rec("events", await eventsSince(b, since));
    });
  });

  test("replaceDocument: a replace, with its own system fields, another _id, gone, not an id, the schema", async () => {
    await same(async (b, rec) => {
      await m(b, "addDocument", { table: "rfree", documents: [{ k: 1 }, { k: 2 }] });
      const [a, bb] = await idsOf(b, "rfree");
      const since = Date.now() - 1;
      rec("replace", await m(b, "replaceDocument", { id: a, document: { label: "r" } }));
      const doc = (await dump(b, "rfree"))[0]!;
      rec("with its system fields", await m(b, "replaceDocument", { id: a, document: { ...doc, label: "r2" } }));
      rec("another _id", await m(b, "replaceDocument", { id: a, document: { _id: bb, label: "r3" } }));
      rec("not an id", await m(b, "replaceDocument", { id: "nope", document: {} }));
      await m(b, "deleteDocuments", { toDelete: [{ id: bb, tableName: "rfree" }] });
      rec("gone", await m(b, "replaceDocument", { id: bb, document: {} }));
      await m(b, "addDocument", { table: "strict", documents: [{ name: "t" }] });
      const s = (await idsOf(b, "strict")).at(-1);
      // a wrong type (a missing field is displayed with the system fields on bunvex: left out, above)
      rec("the schema", await m(b, "replaceDocument", { id: s, document: { name: 1 } }));
      rec("rfree", await dump(b, "rfree"));
      rec("events", await eventsSince(b, since));
    });
  });

  test("deleteDocuments: one event per table named, a gone id, not an id, the limit", async () => {
    await same(async (b, rec) => {
      await m(b, "addDocument", { table: "dfree", documents: [{ k: 1 }, { k: 2 }, { k: 3 }] });
      await m(b, "addDocument", { table: "dother", documents: [{ k: 9 }] });
      const [a, bb, c] = await idsOf(b, "dfree");
      const [o] = await idsOf(b, "dother");
      const since = Date.now() - 1;
      const del = (toDelete: unknown) => m(b, "deleteDocuments", { toDelete });
      rec(
        "two tables",
        await del([
          { id: a, tableName: "dfree" },
          { id: o, tableName: "dother" },
          { id: bb, tableName: "dfree" },
        ]),
      );
      rec(
        "gone",
        await del([
          { id: c, tableName: "dfree" },
          { id: a, tableName: "dfree" },
        ]),
      );
      rec("not an id", await del([{ id: "nope", tableName: "dfree" }]));
      rec("4097", await del(Array.from({ length: 4097 }, () => ({ id: c, tableName: "dfree" }))));
      rec("a wrong table name", await del([{ id: c, tableName: "named" }]));
      rec("no tableName", await del([{ id: c }]));
      rec("dfree", await dump(b, "dfree"));
      rec("events", await eventsSince(b, since));
    });
  });

  test("clearTablePage: 4 000 per page from the oldest, its cursor, an empty table, a system table, a bad cursor", async () => {
    await same(async (b, rec) => {
      await m(b, "addDocument", { table: "cfree", documents: Array.from({ length: 4096 }, (_, i) => ({ i })) });
      await m(b, "addDocument", { table: "cfree", documents: Array.from({ length: 10 }, (_, i) => ({ i: 4096 + i })) });
      const since = Date.now() - 1;
      const first = (await m(b, "clearTablePage", { tableName: "cfree", cursor: null })) as {
        value: { continueCursor: string };
      };
      rec("first", first);
      rec(
        "left after the first",
        (await dump(b, "cfree")).map((d) => d.i),
      );
      rec("second", await m(b, "clearTablePage", { tableName: "cfree", cursor: first.value.continueCursor }));
      rec("empty", await m(b, "clearTablePage", { tableName: "cfree", cursor: null }));
      rec("a system table", await m(b, "clearTablePage", { tableName: "_storage", cursor: null }));
      rec("a bad cursor", await m(b, "clearTablePage", { tableName: "strict", cursor: "nope" }));
      rec("no cursor", await m(b, "clearTablePage", { tableName: "strict" }));
      rec(
        "events",
        (await eventsSince(b, since)).map((e) => ({
          ...e,
          metadata: {
            ...(e.metadata as object),
            document_ids: (e.metadata as { document_ids: unknown[] }).document_ids.length,
          },
        })),
      );
    });
  }, 120_000);

  test("createTable: a new table, a taken one, a declared one that refuses {}, a _ name; one event each", async () => {
    await same(async (b, rec) => {
      const since = Date.now() - 1;
      rec("new", await m(b, "createTable", { table: "made" }));
      await m(b, "addDocument", { table: "made", documents: [{ kept: true }] });
      rec("taken", await m(b, "createTable", { table: "made" }));
      rec("still there", await dump(b, "made"));
      rec("64", await m(b, "createTable", { table: "b".repeat(64) }));
      rec("a _ name", await m(b, "createTable", { table: "_x" }));
      rec("declared any", await m(b, "createTable", { table: "free" }));
      rec("events", await eventsSince(b, since));
    });
  });

  test("an admin key is required: without one, every write is refused", async () => {
    await same(async (b, rec) => {
      for (const [name, args] of [
        ["addDocument", { table: "free", documents: [{}] }],
        ["patchDocumentsFields", { table: "free", fields: { x: 1 } }],
        ["replaceDocument", { id: "x", document: {} }],
        ["deleteDocuments", { toDelete: [] }],
        ["clearTablePage", { tableName: "free", cursor: null }],
        ["createTable", { table: "nokey" }],
      ] as const)
        rec(name, await call(b, "mutation", `_system/frontend/${name}`, args, ""));
    });
  });
});
