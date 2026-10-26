// Dynamic `import()` (STUDY-188 §X14) on Convex's backend (the oracle) and on bunvex's, under `vm` and under the
// `process` function sandbox, the app of `dynamic-import-app/` deployed by each CLI: an action importing a sibling
// module and a chunk only a dynamic import reaches, specifiers resolved against the importing module, missing paths,
// a module that throws while loading (Q3: it fails the action even inside `try`), and queries, mutations and an
// action's nested query, which are refused. A `"use node"` action imports as Node does (`vm` only: Node actions do
// not run under `process` yet). Compared: the status, the value, the error's text without its frames. Convex's
// wording is bunvex's where a decision says so (`bunvex dev`, DV-04), and its Node executor's paths on its own disk
// are dropped. Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dynamic-import: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../dynamic-import-app");
const PROCESS = { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" };

let convex: Backend;
let bunvex: Backend;
let bunvexProcess: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex, bunvexProcess] = await startAll([
    startConvex({ app: APP }),
    startBunvex({ app: APP }),
    startBunvex({ app: APP, env: PROCESS }),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop(), bunvexProcess?.stop()]);
});

/** A value with Convex's CLI named as bunvex's, and its Node executor's module directory left out. */
const ours = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v ?? null)
      .replaceAll("`npx convex dev`", "`bunvex dev`")
      .replaceAll("convex:/", "bunvex:/")
      .replace(/\/[^'"\s]*\/modules\//g, ""),
  );

async function answer(b: Backend, kind: "query" | "mutation" | "action", path: string, args: object) {
  const r = await b.call(kind, path, args);
  const body = r.body as { status?: string; value?: unknown; errorMessage?: string };
  if (body?.status === "success") return { status: r.status, value: ours(body.value) };
  if (body?.status === "error") return { status: r.status, error: errorText(body.errorMessage ?? "") };
  return { status: r.status };
}

const V8_CALLS: ["query" | "mutation" | "action", string, object][] = [
  ["action", "dynamic:sibling", {}],
  ["action", "dynamic:lazyChunk", {}],
  ["action", "dynamic:lazyChunk", {}],
  ...[
    "./helpers",
    "./helpers.js",
    "../helpers",
    "/helpers",
    "./x/../helpers",
    "./dynamic",
    "./nonexistentPath",
    "./nonexistentPath.js",
    "./sub/dir/../../missing",
    "./_generated/api",
    "./schema",
    "helpers",
    "lodash",
  ].map((spec) => ["action", "dynamic:importSpec", { spec }] as ["action", string, object]),
  ["action", "dynamic:throwsOnLoad", {}],
  ["action", "dynamic:throwsOnLoadCaught", {}],
  ["action", "dynamic:throwsOnLoadCaught", {}],
  ["query", "dynamic:inQuery", {}],
  ["query", "dynamic:inQueryCaught", { spec: "./helpers" }],
  ["query", "dynamic:inQueryCaught", { spec: "./nonexistentPath" }],
  ["mutation", "dynamic:inMutation", {}],
  ["mutation", "dynamic:inMutationCaught", { spec: "./helpers" }],
  ["action", "dynamic:nestedQuery", {}],
];

describe.skipIf(!ready)("dynamic import(), against Convex's backend", () => {
  test("the V8 runtime: the same answers under vm and under process", async () => {
    for (const [kind, path, args] of V8_CALLS) {
      const c = await answer(convex, kind, path, args);
      expect({ path, args, ...(await answer(bunvex, kind, path, args)) }).toEqual({ path, args, ...c });
      expect({ path, args, ...(await answer(bunvexProcess, kind, path, args)) }).toEqual({ path, args, ...c });
    }
  });

  test('a V8 action importing a "use node" module: an internal error (vm and process)', async () => {
    const args = { spec: "./node" };
    const c = await answer(convex, "action", "dynamic:importSpec", args);
    expect(c).toEqual({ status: 500 });
    expect(await answer(bunvex, "action", "dynamic:importSpec", args)).toEqual(c);
    expect(await answer(bunvexProcess, "action", "dynamic:importSpec", args)).toEqual(c);
  });

  test('a "use node" action imports as Node does (vm)', async () => {
    const calls: [string, object][] = [
      ["node:sibling", {}],
      ...["./helpers", "./nonexistentPath", "./dynamic"].map(
        (spec) => ["node:importSpec", { spec }] as [string, object],
      ),
      ["node:throwsOnLoadCaught", {}],
    ];
    for (const [path, args] of calls) {
      const c = await answer(convex, "action", path, args);
      expect({ path, args, ...(await answer(bunvex, "action", path, args)) }).toEqual({ path, args, ...c });
    }
  });
});
