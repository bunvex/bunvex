// A deploy that adds a search and a vector index to a table with documents, then a search and a vector search at
// once (STUDY-195 §2), on Convex's backend (the oracle) and on bunvex's: Convex's push builds the indexes before it
// finishes, so both find every document; bunvex's did not (`IndexBackfillingError`). Local only: skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`search-after-deploy: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../search-push-app");
const projects: Record<string, string> = {};
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([
    startConvex({ app: APP, prepare: (p) => (projects.convex = p) }),
    startBunvex({ app: APP, prepare: (p) => (projects.bunvex = p) }),
  ]);
  for (const b of [convex, bunvex])
    for (let i = 0; i < 3; i++)
      expect((await b.call("mutation", "docs:many", { from: i * 1000, n: 1000 })).body).toMatchObject({
        status: "success",
      });
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** The deployed schema with both indexes added to `docs` (the project's own file, in its own package names). */
const INDEXES = `.searchIndex("search_body", { searchField: "body" }).vectorIndex("by_v", { vectorField: "v", dimensions: 2 })`;

async function deployIndexedThenSearch(b: Backend) {
  const file = join(projects[b.name]!, b.name, "schema.ts");
  const source = readFileSync(file, "utf8");
  const table = "defineTable({ body: v.string(), v: v.array(v.float64()) })";
  expect(source).toContain(table);
  writeFileSync(file, source.replace(table, `${table}${INDEXES}`));
  await b.cli(["deploy", ...(b.name === "convex" ? ["--yes"] : []), "--typecheck=disable"]);
  const search = (await b.call("query", "docs:search", {})).body;
  const nearest = (await b.call("action", "docs:nearest", {})).body;
  return { search, nearest };
}

describe.skipIf(!ready)("a search right after a deploy that adds its index, against Convex's backend", () => {
  test("the search and the vector search find every document at once", async () => {
    const c = await deployIndexedThenSearch(convex);
    const b = await deployIndexedThenSearch(bunvex);
    expect(c).toMatchObject({ search: { status: "success", value: 1000 }, nearest: { status: "success", value: 5 } });
    expect(b).toMatchObject({ search: { status: "success", value: 1000 }, nearest: { status: "success", value: 5 } });
  }, 300_000);
});
