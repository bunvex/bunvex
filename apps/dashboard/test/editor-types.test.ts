// The custom test query's types (STUDY-162), checked with TypeScript's own language service over the files the
// editor gets: the declarations bundle (editor-types.ts) and the query's own files (`queryTypeFiles`) for a schema.
// What Monaco's TypeScript worker would say, without a browser: the API resolves, a table name completes, a type
// error is one. In Chromium: the dashboard's e2e.
import { beforeAll, describe, expect, test } from "bun:test";
import type { SchemaInfo } from "@bunvex/dashboard/data-source";
import { QUERY_FILE, queryTypeFiles } from "@bunvex/dashboard/runner/query-types";
import { QUERY_COMPILER_OPTIONS } from "@bunvex/ui/lib/query-compiler-options";
import ts from "typescript";
import { editorTypes, MODULES } from "../editor-types.ts";

let bundle: Record<string, string>;
beforeAll(() => {
  bundle = editorTypes();
}, 120_000);

const SCHEMA: SchemaInfo = {
  enforced: true,
  tables: [
    {
      name: "users",
      validator: {
        type: "object",
        value: {
          name: { fieldType: { type: "string" }, optional: false },
          age: { fieldType: { type: "number" }, optional: true },
          embedding: { fieldType: { type: "array", value: { type: "number" } }, optional: true },
        },
      },
      // the schema's own lists (STUDY-162 §8): the code writes every kind, and the types know them
      indexes: {
        database: [{ name: "by_name", fields: ["name"], staged: false }],
        search: [{ name: "search_name", searchField: "name", filterFields: ["age"], staged: false }],
        vector: [{ name: "by_embedding", vectorField: "embedding", dimensions: 2, filterFields: [], staged: false }],
      },
    },
  ],
};
const TABLES = [
  {
    name: "users",
    declared: true,
    indexes: [
      { name: "by_id", fields: ["_id"], system: true, state: "ready" as const },
      { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" as const },
      { name: "by_name", fields: ["name"], system: false, state: "ready" as const },
    ],
  },
];

/** A language service over the bundle, the query's files and `code` as the test query. */
function service(code: string, schema: SchemaInfo = SCHEMA) {
  const files: Record<string, string> = { ...bundle, ...queryTypeFiles(schema, TABLES), [QUERY_FILE]: code };
  const toPath = (uri: string) => uri.replace(/^file:\/\//, "");
  const byPath = new Map(Object.entries(files).map(([k, v]) => [toPath(k), v]));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...byPath.keys()].filter((f) => /\.tsx?$/.test(f)),
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      const text = byPath.get(f) ?? ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => ({ ...QUERY_COMPILER_OPTIONS, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"] }) as never,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => byPath.has(f) || ts.sys.fileExists(f),
    readFile: (f) => byPath.get(f) ?? ts.sys.readFile(f),
    directoryExists: (d) => [...byPath.keys()].some((f) => f.startsWith(`${d}/`)) || ts.sys.directoryExists(d),
    getDirectories: () => [],
  };
  const ls = ts.createLanguageService(host);
  const file = toPath(QUERY_FILE);
  const errors = () =>
    [...ls.getSemanticDiagnostics(file), ...ls.getSyntacticDiagnostics(file)].map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    );
  return { ls, file, errors };
}

describe("the custom test query's types", () => {
  test("the bundle: bunvex/server and bunvex/values resolve, beside @bunvex/*'s declarations", () => {
    expect(bundle[`${MODULES}/bunvex/server.d.ts`]).toBe('export * from "@bunvex/server";\n');
    expect(bundle[`${MODULES}/@bunvex/server/index.d.ts`]).toBe('export * from "./src/index.js";\n');
    expect(bundle[`${MODULES}/@bunvex/values/index.d.ts`]).toBeDefined();
    // only what the API's types reach: no test helper, no driver
    expect(Object.keys(bundle).some((f) => /test-runtime|conformance|postgres/.test(f))).toBe(false);
    const bytes = Object.values(bundle).reduce((n, t) => n + t.length, 0);
    // measured at 658 KB in 149 files (STUDY-162 §4); a much larger closure is worth a look
    expect(bytes).toBeLessThan(1_000_000);
  });

  test("a query over the schema's table checks clean", () => {
    const { errors } = service(`export default query({
  handler: async (ctx) => {
    const users = await ctx.db.query("users").withIndex("by_name", (q) => q.eq("name", "Ada")).take(10);
    return users.map((u) => u.name.toUpperCase() + (u.age ?? 0));
  },
});`);
    expect(errors()).toEqual([]);
  });

  test("a table the schema does not declare, a field of the wrong type: errors", () => {
    const { errors } = service(`export default query({
  handler: async (ctx) => {
    const n: number = (await ctx.db.query("users").first())!.name;
    return await ctx.db.query("nope").take(1);
  },
});`);
    const all = errors().join("\n");
    expect(all).toContain("Type 'string' is not assignable to type 'number'");
    expect(all).toContain('"nope"');
  });

  test('completions: the tables after ctx.db.query(", the index names after withIndex("', () => {
    const code = `export default query({ handler: async (ctx) => ctx.db.query("`;
    const { ls, file } = service(`${code}users").withIndex("by_name").take(1) });`);
    const tables = ls.getCompletionsAtPosition(file, code.length, {})?.entries.map((e) => e.name);
    expect(tables).toContain("users");
    const at = `${code}users").withIndex("`.length;
    const indexes = ls.getCompletionsAtPosition(file, at, {})?.entries.map((e) => e.name);
    expect(indexes).toContain("by_name");
  });

  test('search indexes: their names complete after withSearchIndex(", a name the schema does not declare is an error', () => {
    const code = `export default query({ handler: async (ctx) => ctx.db.query("users").withSearchIndex("`;
    const { ls, file } = service(`${code}search_name", (q) => q.search("name", "ada").eq("age", 3)).take(1) });`);
    const names = ls.getCompletionsAtPosition(file, code.length, {})?.entries.map((e) => e.name);
    expect(names).toContain("search_name");
    expect(names).not.toContain("by_name");
    const { errors } = service(
      `export default query({ handler: async (ctx) => ctx.db.query("users").withSearchIndex("nope", (q) => q.search("name", "a")).take(1) });`,
    );
    expect(errors().join("\n")).toContain('"nope"');
    // and its search field, from the schema
    const wrongField = service(
      `export default query({ handler: async (ctx) => ctx.db.query("users").withSearchIndex("search_name", (q) => q.search("age", "a")).take(1) });`,
    );
    expect(wrongField.errors().join("\n")).toContain('"age"');
  });

  test("vector indexes: written into the schema the types read", () => {
    const files = queryTypeFiles(SCHEMA, TABLES);
    expect(files["file:///schema.ts"]).toContain(
      '.vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 2 })',
    );
  });

  test("without a schema: any table, documents of any type", () => {
    const { errors } = service(
      `export default query({ handler: async (ctx) => (await ctx.db.query("anything").first())?.whatever });`,
      { enforced: true, tables: [] },
    );
    expect(errors()).toEqual([]);
  });

  test("process.env has the deployment's URLs", () => {
    const { errors } = service(
      `export default query({ handler: async () => process.env.BUNVEX_CLOUD_URL.length + (process.env.OTHER ?? "").length });`,
    );
    expect(errors()).toEqual([]);
  });
});
