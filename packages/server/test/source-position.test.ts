// Each function's source position in the push analysis (STUDY-65 M5), as Convex's analyze computes it
// (crates/isolate/src/environment/analyze.rs; its `test_analyze_with_source_map`): the handler's start in the
// bundle, looked up in the module's source map one line and one column further (Convex's lookup), reported
// as the original 0-based line and column; functions and routes sorted by it; none without a source map, or
// for a handler in a shared chunk.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodeVersion, type ModuleSource } from "../src/code-version.ts";
import { decodeMappings, functionStartOffset, handlerOffset, lookupToken } from "../src/source-position.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The app's import, spelled so the dependency checker does not take it for this test's own.
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));

/** `files` bundled as the CLI bundles them (ESM, chunks under `_deps/`, external source maps). */
async function bundle(files: Record<string, string>, entries: string[]): Promise<ModuleSource[]> {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-pos-"));
  dirs.push(dir);
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  }
  const r = await Bun.build({
    entrypoints: entries.map((e) => join(dir, e)),
    root: dir,
    splitting: true,
    format: "esm",
    target: "browser",
    sourcemap: "external",
    minify: { syntax: true },
    external: ["bunvex", "bunvex/*"],
    naming: { entry: "[dir]/[name].js", chunk: "_deps/[hash].js" },
  });
  if (!r.success) throw new Error(r.logs.join("\n"));
  const maps = new Map<string, string>();
  for (const o of r.outputs) if (o.kind === "sourcemap") maps.set(o.path.replace(/\.map$/, ""), await o.text());
  const out: ModuleSource[] = [];
  for (const o of r.outputs) {
    if (o.kind === "sourcemap") continue;
    const map = maps.get(o.path);
    out.push({
      path: o.path.replace(/^\.\//, ""),
      source: await o.text(),
      ...(map ? { sourceMap: map } : {}),
      environment: "isolate",
    });
  }
  return out;
}
const load = (modules: ModuleSource[]) =>
  CodeVersion.load(modules, { seed: Uint32Array.of(1, 2, 3, 4), timestamp: 1_700_000_000_000 });

const MESSAGES = `import { action, internalAction, query } from ${SERVER};

export const hello = action(async ({}) => {
  console.log("analyze me pls");
});
export const internalHello = internalAction(async ({}) => {
  console.log("analyze me pls");
});

export const zeta = query({
  args: {},
  handler: async (ctx) => {
    for (const x of [1]) console.log(x);
    return 1;
  },
});
export const alpha = query({
  handler: async (ctx) => {
    for (const y of [2]) console.log(y);
    return 2;
  },
});
export const method = query({
  async handler(ctx) {
    for (const m of [3]) console.log(m);
    return 3;
  },
});
`;

test("Convex's test_analyze_with_source_map: each function's line, the functions in source order", async () => {
  const v = await load(await bundle({ "messages.ts": MESSAGES }, ["messages.ts"]));
  const fns = v.analysis["messages.js"]!.functions;
  // Convex's lookup lands on the body's first line: the handler's line, 1-based. Sorted by it, not by name.
  expect(fns.map((f) => [f.name, f.pos?.path, f.pos?.start_lineno])).toEqual([
    ["hello", "messages.js", 3],
    ["internalHello", "messages.js", 6],
    ["zeta", "messages.js", 12],
    ["alpha", "messages.js", 18],
    // A method starts at its parameters: the lookup's column reaches the body's first token.
    ["method", "messages.js", 24],
  ]);
  for (const f of fns) expect(typeof f.pos!.start_col).toBe("number");
});

test("identical handlers: each gets its own export's position", async () => {
  const src = `import { query } from ${SERVER};

export const one = query({
  handler: async () => {
    for (const z of [3]) console.log(z);
    return 1;
  },
});

export const two = query({
  handler: async () => {
    for (const z of [3]) console.log(z);
    return 1;
  },
});
`;
  const v = await load(await bundle({ "same.ts": src }, ["same.ts"]));
  expect(v.analysis["same.js"]!.functions.map((f) => [f.name, f.pos?.start_lineno])).toEqual([
    ["one", 4],
    ["two", 11],
  ]);
});

test("no position without a source map, with a broken one, or for a handler in a shared chunk", async () => {
  const shared = `import { query } from ${SERVER};
export const make = () =>
  query(async () => {
    return "shared";
  });
`;
  const modules = await bundle(
    {
      "lib.ts": shared,
      "a.ts": `import { make } from "./lib";\nexport const viaLib = make();\n`,
      "b.ts": `import { make } from "./lib";\nexport const other = make();\n`,
    },
    ["a.ts", "b.ts"],
  );
  expect(modules.some((m) => m.path.startsWith("_deps/"))).toBe(true);
  const v = await load(modules);
  expect(v.analysis["a.js"]!.functions).toMatchObject([{ name: "viaLib", pos: null }]);

  const m = (await bundle({ "messages.ts": MESSAGES }, ["messages.ts"]))[0]!;
  const bare = await load([{ ...m, sourceMap: undefined }]);
  expect(bare.analysis["messages.js"]!.functions.every((f) => f.pos === null)).toBe(true);
  // Without positions, the namespace's order (Convex sorts a missing position first, stably).
  expect(bare.analysis["messages.js"]!.functions.map((f) => f.name)).toEqual([
    "alpha",
    "hello",
    "internalHello",
    "method",
    "zeta",
  ]);
  const broken = await load([{ ...m, sourceMap: "{not json" }]);
  expect(broken.analysis["messages.js"]!.functions.every((f) => f.pos === null)).toBe(true);
});

test("http routes: Convex's { route, pos }, sorted by position", async () => {
  const http = `import { httpAction, httpRouter } from ${SERVER};
const http = httpRouter();
http.route({
  path: "/z",
  method: "GET",
  handler: httpAction(async () => {
    for (const z of [4]) console.log(z);
    return new Response("z");
  }),
});
http.route({
  path: "/a",
  method: "POST",
  handler: httpAction(async () => {
    for (const a of [5]) console.log(a);
    return new Response("a");
  }),
});
export default http;
`;
  const v = await load(await bundle({ "http.ts": http }, ["http.ts"]));
  expect(v.analysis["http.js"]!.httpRoutes!.map((r) => [r.route, r.pos?.start_lineno])).toEqual([
    [{ path: "/z", method: "GET" }, 6],
    [{ path: "/a", method: "POST" }, 14],
  ]);
});

test("V8's function start: an arrow at its first character, any other function at its parameters", () => {
  expect(functionStartOffset("async (ctx) => 1")).toBe(0);
  expect(functionStartOffset("async ctx => 1")).toBe(0);
  expect(functionStartOffset("(ctx) => 1")).toBe(0);
  expect(functionStartOffset("ctx => 1")).toBe(0);
  expect(functionStartOffset("async handler(ctx) { return 1; }")).toBe(13);
  expect(functionStartOffset("handler(ctx) { return 1; }")).toBe(7);
  expect(functionStartOffset("async function(ctx) { return 1; }")).toBe(14);
  expect(functionStartOffset("async function named(ctx) { return 1; }")).toBe(20);
  expect(functionStartOffset("function* (ctx) { return 1; }")).toBe(10);
});

test("the mappings decoder and the at-or-before lookup", () => {
  // Line 0: [0,0,0,0] and [4,0,1,2]; line 1 empty; line 2: [2,0,3,0].
  const t = decodeMappings("AAAA,IACE;;EAEF")!;
  expect([...t]).toEqual([0, 0, 0, 0, 0, 4, 1, 2, 2, 2, 3, 0]);
  // Out of order within a line: sorted.
  expect([...decodeMappings("IAAA,DAAC")!]).toEqual([0, 3, 0, 1, 0, 4, 0, 0]);
  expect(lookupToken(t, 0, 3)).toEqual([0, 0, 0, 0]);
  expect(lookupToken(t, 0, 4)).toEqual([0, 4, 1, 2]);
  expect(lookupToken(t, 1, 0)).toEqual([0, 4, 1, 2]); // an earlier line's token, as the lookup Convex uses
  expect(lookupToken(t, 2, 1)).toEqual([0, 4, 1, 2]);
  expect(lookupToken(t, 2, 2)).toEqual([2, 2, 3, 0]);
  expect(decodeMappings("A!")).toBeNull();
  expect(decodeMappings("AAA")).toBeNull(); // three fields
  expect(decodeMappings("g")).toBeNull(); // a value cut short
  expect(handlerOffset("var a = x;", () => 1, null)).toBeNull();
});
