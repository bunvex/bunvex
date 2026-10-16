// The Data screen's search filter (STUDY-163 §5): `_system/frontend/paginatedTableDocuments` with Convex's
// `SearchIndexFilter` (the text, equalities on filter fields) and field clauses on top, on Convex's backend (the oracle)
// and on bunvex's, for the app of `indexes-app/`: the documents found (as sets: both rank by relevance, each with its own
// index), and every refusal compared word for word. Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready)
  console.warn(`dashboard-search-filter: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../indexes-app");
let convex: Backend;
let bunvex: Backend;

type Answer = { page?: Record<string, unknown>[]; isDone?: boolean; error?: string };

/** A page of `docs` under `expr` (Convex's FilterExpression), as an admin: the bodies found (sorted), or the refusal. */
async function page(b: Backend, expr: unknown): Promise<Answer> {
  const r = await fetch(`${b.url}/api/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
    },
    body: JSON.stringify({
      path: "_system/frontend/paginatedTableDocuments",
      args: {
        table: "docs",
        filters: Buffer.from(JSON.stringify(expr)).toString("base64"),
        paginationOpts: { numItems: 100, cursor: null },
      },
      format: "json",
    }),
  });
  const body = (await r.json()) as {
    status: string;
    value?: { page: Record<string, unknown>[]; isDone: boolean };
    errorMessage?: string;
  };
  if (body.status !== "success") return { error: body.errorMessage };
  const { page, isDone } = body.value!;
  return {
    page: page
      .map((d) => ("_id" in d ? { body: d.body } : d))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    isDone,
  };
}

const same = async (what: string, expr: unknown) => {
  const [c, b] = [await page(convex, expr), await page(bunvex, expr)];
  expect({ what, answer: b }).toEqual({ what, answer: c });
  return c;
};

const search = (text: string, clauses: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  clauses: [],
  order: "asc",
  index: { name: "search_body", search: text, clauses },
  ...extra,
});

describe.skipIf(!ready)("the search filter on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
    for (const b of [convex, bunvex]) {
      const r = await b.call("mutation", "docs:add", { n: 20 });
      if (!r.ok) throw new Error(`${b.name}: ${JSON.stringify(r.body)}`);
    }
    // the search indexes are built (bunvex builds after the push; Convex before it finishes)
    for (const b of [convex, bunvex])
      for (let i = 0; i < 100 && ((await page(b, search("doc"))).page?.length ?? 0) < 20; i++) await Bun.sleep(100);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("the text, equalities on filter fields, field clauses on top", async () => {
    expect((await same("words", search("doc"))).page).toHaveLength(20);
    await same("a prefix", search("do"));
    await same("an exact number", search("17"));
    await same("an equality", search("doc", [{ field: "author", enabled: true, value: "ana" }]));
    await same("a disabled equality", search("doc", [{ field: "author", enabled: false, value: "ana" }]));
    await same(
      "two equalities",
      search("doc", [
        { field: "author", enabled: true, value: "bo" },
        { field: "n", enabled: true, value: 4 },
      ]),
    );
    await same(
      "a field clause on the results",
      search("doc", [], { clauses: [{ id: "a", field: "n", op: "lt", value: 5, enabled: true }] }),
    );
    await same("nothing found", search("zebra"));
    await same("an empty search", search(""));
  });

  test("refusals: descending, not a search index, not a filter field, twice the same field", async () => {
    await same("descending", search("doc", [], { order: "desc" }));
    await same("no such index", { ...search("doc"), index: { name: "nope", search: "doc", clauses: [] } });
    await same("a database index", { ...search("doc"), index: { name: "by_author", search: "doc", clauses: [] } });
    await same("not a filter field", search("doc", [{ field: "title", enabled: true, value: "x" }]));
    await same(
      "twice",
      search("doc", [
        { field: "author", enabled: true, value: "ana" },
        { field: "author", enabled: true, value: "bo" },
      ]),
    );
  });
});
