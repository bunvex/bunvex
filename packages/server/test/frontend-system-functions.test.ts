// The Functions and Settings screens' reads (STUDY-149 PR 4), where Convex's local backend is not needed to tell
// (the oracle is packages/differential/test/dashboard-functions.test.ts): rows only a hand-made store has — a
// module without an analysis or a position, a child component, an empty version, an import's own fields — and
// each function's permission.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { setCanonicalUrl } from "../src/canonical-urls.ts";
import { FRONTEND_SYSTEM_QUERIES } from "../src/frontend-system-functions.ts";
import { Functions } from "../src/functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    storedSchema: true,
  }).init();
  stops.push(() => engine.close());
  const functions = new Functions(engine);
  const sys = (name: string, args: Record<string, unknown> = {}) =>
    functions.runSystemQuery(`_system/frontend/${name}`, args) as Promise<never>;
  const insert = (table: string, doc: Record<string, unknown>) =>
    engine.mutation((db) => db.asSystem(() => db.insert(table, doc as never))) as Promise<string>;
  return { engine, functions, sys, insert };
}

const fn = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  pos: null,
  udfType: "Query",
  visibility: { kind: "public" },
  args: '{"type":"object","value":{}}',
  returns: '{"type":"any"}',
  ...extra,
});
const pos = (line: number) => ({ path: "m.ts", start_lineno: BigInt(line), start_col: 1n });

describe("modules", () => {
  test("a module without an analysis is left out; a function without a position has no line; routes and crons", async () => {
    const { sys, insert } = await setup();
    await insert("_modules", {
      path: "schema.js",
      sourcePackageId: "p",
      environment: "isolate",
      sha256: "x",
      analyzeResult: null,
    });
    await insert("_modules", {
      path: "m.js",
      sourcePackageId: "p",
      environment: "isolate",
      sha256: "y",
      analyzeResult: {
        functions: [fn("a", { pos: pos(7) }), fn("b", { visibility: null, udfType: "Mutation" })],
        httpRoutes: [{ route: { path: "/x", method: "GET" }, pos: pos(0) }],
        cronSpecs: [{ identifier: "c", spec: { udfPath: "m.js:a" } }],
        sourceMapped: null,
      },
    });
    const all = (await sys("modules:listForAllComponents")) as [null, [string, unknown][]][];
    expect(all).toEqual([
      [
        null,
        [
          [
            "m.js",
            {
              functions: [
                { name: "a", lineno: 7, udfType: "Query", visibility: { kind: "public" } },
                // no visibility recorded: public, as Convex's
                { name: "b", udfType: "Mutation", visibility: { kind: "public" } },
                // line 0 is no line (Convex's `lineno ? Number(lineno) : undefined`)
                { name: "GET /x", udfType: "HttpAction", visibility: { kind: "public" } },
              ],
              sourcePackageId: "p",
              cronSpecs: [["c", { udfPath: "m.js:a" }]],
            },
          ],
        ],
      ],
    ]);
    expect(await sys("modules:list", { componentId: null })).toEqual(all[0]![1] as never);
  });

  test("argsValidator: by display name; the default export; a function without one; misses are null", async () => {
    const { sys, insert } = await setup();
    await insert("_modules", {
      path: "dir/m.js",
      sourcePackageId: "p",
      environment: "isolate",
      sha256: "y",
      analyzeResult: {
        functions: [fn("send"), fn("default", { args: undefined })],
        httpRoutes: null,
        cronSpecs: null,
        sourceMapped: null,
      },
    });
    const args = (f: string) => sys("modules:argsValidator", { function: f });
    expect(await args("dir/m:send")).toBe('{"type":"object","value":{}}' as never);
    expect(await args("dir/m")).toBe('{ "type": "any" }' as never);
    expect(await args("dir/m:nope")).toBeNull();
    expect(await args("dir/m.js:send")).toBeNull();
    expect(await args("other:send")).toBeNull();
  });
});

describe("components:list", () => {
  test("each component's path from its parents; the root's is empty", async () => {
    const { sys, insert } = await setup();
    // a push writes the root's row; a child here is hand-made (bunvex has no components, DV-55)
    const root = await insert("_components", {
      definitionId: "d",
      parent: null,
      name: null,
      args: null,
      state: "active",
      httpPrefix: null,
    });
    const a = await insert("_components", { definitionId: "d", parent: root, name: "a", args: [["x", 1]] });
    await insert("_components", {
      definitionId: "d",
      parent: a,
      name: "b",
      args: null,
      state: "unmounted",
      httpPrefix: "/b/",
    });
    const list = (await sys("components:list")) as {
      path: string;
      args: unknown;
      state: string;
      httpPrefix: unknown;
    }[];
    expect(list.map((c) => [c.path, c.args, c.state, c.httpPrefix])).toEqual([
      ["", {}, "active", null],
      ["a", { x: 1 }, "active", null],
      ["a/b", {}, "unmounted", "/b/"],
    ]);
  });
});

describe("getVersion and the URLs", () => {
  test("the pushed version, or null for none or an empty one", async () => {
    const { sys, insert } = await setup();
    expect(await sys("getVersion")).toBeNull();
    await insert("_udf_config", {
      serverVersion: "",
      importPhaseRngSeed: new ArrayBuffer(32),
      importPhaseUnixTimestamp: 0n,
    });
    expect(await sys("getVersion")).toBeNull();
  });

  test("cloudUrl and siteUrl: the canonical URL when set, else the server's", async () => {
    const { sys, engine, functions } = await setup();
    functions.builtinEnv = { BUNVEX_CLOUD_URL: "http://127.0.0.1:3210", BUNVEX_SITE_URL: "http://127.0.0.1:3211" };
    expect(await sys("cloudUrl")).toBe("http://127.0.0.1:3210" as never);
    expect(await sys("siteUrl")).toBe("http://127.0.0.1:3211" as never);
    await engine.mutation((db) => setCanonicalUrl(db, "bunvexSite", "https://site.example"));
    expect(await sys("siteUrl")).toBe("https://site.example" as never);
  });
});

describe("snapshotImport:list", () => {
  test("the newest 20, without bunvex's own fields", async () => {
    const { sys, insert } = await setup();
    for (let i = 0; i < 22; i++)
      await insert("_snapshot_imports", { state: { state: "uploaded" }, n: i, object_size: 1n, hidden_tables: [] });
    const list = (await sys("snapshotImport:list")) as Record<string, unknown>[];
    expect(list).toHaveLength(20);
    expect(list[0]!.n).toBe(21);
    expect(list.some((r) => "object_size" in r || "hidden_tables" in r)).toBe(false);
  });
});

test("each one's permission, as Convex's", () => {
  const op = (name: string) => {
    const q = FRONTEND_SYSTEM_QUERIES[`_system/frontend/${name}`]!;
    return q.noPermissionRequired ? "none" : (q.op ?? "ViewData");
  };
  expect(
    Object.fromEntries(
      [
        "modules:listForAllComponents",
        "modules:list",
        "modules:argsValidator",
        "components:list",
        "getVersion",
        "cloudUrl",
        "siteUrl",
        "listEnvironmentVariables",
        "latestExport",
        "snapshotImport:list",
      ].map((n) => [n, op(n)]),
    ),
  ).toEqual({
    "modules:listForAllComponents": "ViewData",
    "modules:list": "ViewData",
    "modules:argsValidator": "ViewData",
    "components:list": "ViewData",
    getVersion: "none",
    cloudUrl: "ViewData",
    siteUrl: "ViewData",
    listEnvironmentVariables: "ViewEnvironmentVariables",
    latestExport: "ViewBackups",
    "snapshotImport:list": "ViewBackups",
  });
});
