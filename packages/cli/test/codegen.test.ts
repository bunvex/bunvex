// Codegen (STUDY-36): the generated files (golden snapshots), module identifiers, the initial and final
// passes, and end to end — an app's `_generated/` typechecks with the real `tsc` against the bunvex packages,
// and a type error fails `bunvex codegen`.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatedFiles, importPath, moduleIdentifier, modulePaths, runCodegen } from "../src/codegen.ts";
import { codegenConfig } from "../src/deploy.ts";
import { main } from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-codegen-"));
  dirs.push(d);
  return d;
};
const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};
const io = (cwd: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, it: { env: {}, cwd, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");

describe("the generated files", () => {
  const paths = ["messages.ts", "foo/bar-baz.ts", "delete.ts", "api.ts"];
  test("api, server and dataModel (golden)", () => {
    expect(generatedFiles(paths, { hasSchema: true, fileType: "js/dts" })).toMatchSnapshot();
  });
  test("without a schema, and with fileType ts (golden)", () => {
    expect(generatedFiles(paths, { hasSchema: false, fileType: "ts" })).toMatchSnapshot();
  });
  test("module keys and identifiers, as Convex's", () => {
    expect(importPath("foo/bar-baz.ts")).toBe("foo/bar-baz");
    expect(importPath("foo\\bar.js")).toBe("foo/bar");
    expect(moduleIdentifier("foo/bar-baz.ts")).toBe("foo_bar_baz");
    expect(moduleIdentifier("delete.ts")).toBe("delete_");
    expect(moduleIdentifier("api.ts")).toBe("api_");
    expect(moduleIdentifier("fullApi.ts")).toBe("fullApi_");
    const dts = generatedFiles(paths, { hasSchema: true, fileType: "js/dts" }).api["api.d.ts"]!;
    expect(dts).toContain(`import type * as foo_bar_baz from "../foo/bar-baz.js";`);
    expect(dts).toContain(`  "foo/bar-baz": typeof foo_bar_baz;`);
    expect(dts).toContain(`  messages: typeof messages;`);
    expect(dts).not.toMatch(/convex/i);
  });
  test("an app on the scoped packages gets @bunvex/* imports (STUDY-40)", () => {
    const scoped = generatedFiles(["a.ts"], { hasSchema: true, fileType: "js/dts", packages: "@bunvex" });
    const all = [
      ...Object.values(scoped.server),
      ...Object.values(scoped.api),
      ...Object.values(scoped.dataModel),
    ].join("\n");
    expect(all).toContain(`from "@${SERVER}"`);
    expect(all).toContain(`from "@${VALUES}"`);
    expect(all).not.toMatch(/from "bunvex\//);
    const dir = tmp();
    const config = (deps: Record<string, string>) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
      return codegenConfig(dir).packages;
    };
    expect(config({ "@bunvex/server": "0.1.0" })).toBe("@bunvex");
    expect(config({ bunvex: "0.1.0", "@bunvex/react": "0.1.0" })).toBe("bunvex");
    expect(config({})).toBe("bunvex");
  });

  test("the modules are the bundler's entry points, in code-unit order", () => {
    const app = tmp();
    write(app, {
      "b.ts": "export const x = 1;",
      "a/z.ts": "export const x = 1;",
      "A.ts": "export const x = 1;",
      "schema.ts": "export default 1;",
      "a.test.ts": "export const x = 1;",
      "_generated/api.js": "export const api = 1;",
    });
    expect(modulePaths(app)).toEqual(["A.ts", "a/z.ts", "b.ts"]);
  });
});

describe("runCodegen", () => {
  test("the initial pass writes stubs and api.js, keeps what exists, and removes stale entries", () => {
    const fns = join(tmp(), "bunvex");
    write(fns, { "messages.ts": "export const x = 1;", "_generated/old.ts": "", "_generated/server.js": "// mine" });
    const r = runCodegen(fns, { fileType: "js/dts" }, { initial: true });
    expect(r.written.sort()).toEqual(["api.d.ts", "api.js", "dataModel.d.ts"]);
    expect(r.removed).toEqual(["old.ts"]);
    expect(readFileSync(join(fns, "_generated/server.js"), "utf8")).toBe("// mine");
    expect(readFileSync(join(fns, "_generated/api.d.ts"), "utf8")).toContain("AnyApi");
    expect(readFileSync(join(fns, "_generated/dataModel.d.ts"), "utf8")).toContain(
      "export type DataModel = AnyDataModel;",
    );
    // server.js existed, so the pair was left alone (server.d.ts is not written either). The final pass
    // writes everything.
    expect(existsSync(join(fns, "_generated/server.d.ts"))).toBe(false);
    const f = runCodegen(fns, { fileType: "js/dts" });
    expect(f.written.sort()).toEqual(["api.d.ts", "server.d.ts", "server.js"]);
    expect(readFileSync(join(fns, "_generated/api.d.ts"), "utf8")).toContain("typeof messages");
    // Unchanged files are not rewritten.
    const before = statSync(join(fns, "_generated/api.d.ts")).mtimeMs;
    expect(runCodegen(fns, { fileType: "js/dts" }).written).toEqual([]);
    expect(statSync(join(fns, "_generated/api.d.ts")).mtimeMs).toBe(before);
    // A schema turns the data model on; switching to fileType ts replaces the pairs.
    write(fns, { "schema.ts": "export default 1;" });
    runCodegen(fns, { fileType: "js/dts" });
    expect(readFileSync(join(fns, "_generated/dataModel.d.ts"), "utf8")).toContain("typeof schema");
    const ts = runCodegen(fns, { fileType: "ts" });
    expect(ts.removed.sort()).toEqual(["api.d.ts", "api.js", "dataModel.d.ts", "server.d.ts", "server.js"]);
    expect(existsSync(join(fns, "_generated/server.ts"))).toBe(true);
  });
});

// An app whose `bunvex` and `typescript` packages are the workspace's.
function appWithPackages(files: Record<string, string>) {
  const app = tmp();
  mkdirSync(join(app, "node_modules"));
  symlinkSync(resolve(import.meta.dir, "../../bunvex"), join(app, "node_modules/bunvex"));
  symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(app, "node_modules/typescript"));
  write(app, files);
  return app;
}

const TYPED_APP = {
  "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export default defineSchema({
  messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
});`,
  "bunvex/messages.ts": `import { v } from ${JSON.stringify(VALUES)};
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  args: { author: v.string() },
  handler: async (ctx, { author }): Promise<Doc<"messages">[]> =>
    ctx.db.query("messages").withIndex("by_author", (q) => q.eq("author", author)).collect(),
});
export const send = mutation({
  args: { author: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<Id<"messages">> => {
    await ctx.scheduler.runAfter(0, internal.messages.clear, {});
    return ctx.db.insert("messages", args);
  },
});
export const clear = internalMutation({ args: {}, handler: async () => {} });
export const relay = action({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const id: Id<"messages"> = await ctx.runMutation(api.messages.send, { author: "relay", body });
    return id;
  },
});`,
};

describe("bunvex codegen, end to end", () => {
  test("--init, then the app typechecks against its _generated/; a type error fails it", async () => {
    const app = appWithPackages(TYPED_APP);
    const r = io(app);
    expect(await main(["codegen", "--init", "--typecheck", "enable"], r.it)).toBe(0);
    expect(r.err).toContain("Wrote bunvex/tsconfig.json");
    expect(r.out[0]).toMatch(/^✔ Generated bunvex\/_generated/);
    // A table that is not in the schema, and the wrong arguments to a mutation.
    write(app, {
      "bunvex/bad.ts": `import { api } from "./_generated/api";
import { action, query } from "./_generated/server";
export const bad = query({ args: {}, handler: (ctx) => ctx.db.query("nope").collect() });
export const worse = action({ args: {}, handler: (ctx) => ctx.runMutation(api.messages.send, { author: "a" }) });`,
    });
    const bad = io(app);
    expect(await main(["codegen"], bad.it)).toBe(1);
    // As Convex's (STUDY-124): the failure and the hint on stderr, the compiler's errors on stdout.
    expect(bad.err).toEqual([
      "✖ TypeScript typecheck via `tsc` failed.",
      "To ignore failing typecheck, use `--typecheck=disable`.",
    ]);
    const output = bad.out.join("\n");
    expect(output).toContain(`bunvex/bad.ts(3,`);
    expect(output).toContain(`'"nope"'`);
    expect(output).toContain(`bunvex/bad.ts(4,`);
    expect(await main(["codegen", "--typecheck=disable"], io(app).it)).toBe(0);
  }, 120_000);

  // STUDY-100 T2: `v` from `_generated/server` types `v.id` with the app's tables and the system tables; with no
  // schema, or `strictTableNameTypes: false`, any table name. T1: `v.id` from bunvex/values takes the system tables.
  test("the generated v: its tables and the system tables; a misspelled table fails, unless the schema is loose", async () => {
    const app = appWithPackages({
      ...TYPED_APP,
      "bunvex/ids.ts": `import { v as plainV } from ${JSON.stringify(VALUES)};
import { query, v } from "./_generated/server";
export const byId = query({
  args: { message: v.id("messages"), file: v.id("_storage"), job: v.id("_scheduled_functions") },
  handler: async (ctx, { message, file }) => [await ctx.db.get(message), await ctx.storage.getUrl(file)],
});
// T1: bunvex/values' v.id keeps the literal: getUrl takes only an Id<"_storage">.
export const plain = query({
  args: { file: plainV.id("_storage") },
  handler: async (ctx, { file }): Promise<string | null> => ctx.storage.getUrl(file),
});`,
    });
    expect(await main(["codegen", "--init", "--typecheck", "enable"], io(app).it)).toBe(0);
    // What an editor completes in `v.id("`: TypeScript's language service, the one editors run.
    write(app, {
      "bunvex/complete.ts": `import { v as plainV } from ${JSON.stringify(VALUES)};
import { v } from "./_generated/server";
plainV.id("");
v.id("");`,
      "complete.mjs": `import ts from "typescript";
const file = process.cwd() + "/bunvex/complete.ts";
const text = ts.sys.readFile(file);
const config = ts.getParsedCommandLineOfConfigFile("bunvex/tsconfig.json", {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
const host = {
  getScriptFileNames: () => [file], getScriptVersion: () => "1",
  getScriptSnapshot: (f) => ts.ScriptSnapshot.fromString(ts.sys.readFile(f) ?? ""),
  getCurrentDirectory: () => process.cwd(), getCompilationSettings: () => config.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o), fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host);
const at = (needle) => (service.getCompletionsAtPosition(file, text.indexOf(needle) + needle.length, {})?.entries ?? []).map((e) => e.name).filter(Boolean).sort();
console.log(JSON.stringify({ plain: at('plainV.id("'), generated: at('\\nv.id("') }));`,
    });
    const probe = Bun.spawnSync(["bun", "complete.mjs"], { cwd: app });
    const completions = JSON.parse(probe.stdout.toString()) as { plain: string[]; generated: string[] };
    expect(completions.plain).toEqual(["_scheduled_functions", "_storage"]);
    expect(completions.generated).toEqual(["_scheduled_functions", "_storage", "messages"]);
    write(app, { "bunvex/typo.ts": `import { v } from "./_generated/server";\nexport const bad = v.id("mesages");` });
    const strict = io(app);
    expect(await main(["codegen"], strict.it)).toBe(1);
    expect(strict.out.join("\n")).toContain(`bunvex/typo.ts(2,`);
    expect(strict.out.join("\n")).toContain(`'"mesages"'`);
    // A loose schema: any table name.
    write(app, {
      "bunvex/schema.ts": TYPED_APP["bunvex/schema.ts"].replace(/\}\);$/, "}, { strictTableNameTypes: false });"),
    });
    expect(await main(["codegen", "--typecheck", "enable"], io(app).it)).toBe(0);
  }, 120_000);

  test("the generated v with no schema: any table name", async () => {
    const app = appWithPackages({
      "bunvex/ids.ts": `import { query, v } from "./_generated/server";
export const byId = query({ args: { id: v.id("anything"), file: v.id("_storage") }, handler: async () => null });`,
    });
    expect(await main(["codegen", "--init", "--typecheck", "enable"], io(app).it)).toBe(0);
  }, 120_000);

  test("without a tsconfig, try skips the typecheck and enable fails", async () => {
    const app = tmp();
    write(app, { "bunvex/a.ts": "export const x = 1;" });
    const r = io(app);
    expect(await main(["codegen"], r.it)).toBe(0);
    expect(r.err.join("\n")).toContain("Found no bunvex/tsconfig.json");
    expect(await main(["codegen", "--typecheck", "enable"], io(app).it)).toBe(1);
    const sometimes = io(app);
    expect(await main(["codegen", "--typecheck", "sometimes"], sometimes.it)).toBe(1);
    // `codegen` shows no help after an argument error, as Convex's.
    expect(sometimes.err).toEqual([
      "error: option '--typecheck <mode>' argument 'sometimes' is invalid. Allowed choices are enable, try, disable.",
    ]);
    // With `enable` and nothing to typecheck with: the reason, then the hint.
    const enable = io(app);
    expect(await main(["codegen", "--typecheck", "enable"], enable.it)).toBe(1);
    expect(enable.err).toEqual([
      "Found no bunvex/tsconfig.json to typecheck the functions with, so skipping typecheck. Run `bunvex codegen --init` to create one.",
      "To ignore failing typecheck, use `--typecheck=disable`.",
    ]);
  });
});

describe("bunvex.json checks, with Convex's messages (STUDY-65 G-L2)", () => {
  // Each expected message is what Convex 1.46's CLI prints for the same convex.json, with the file's name
  // changed (run once against its `cli.bundle.cjs`; not at test time).
  const cases: [string, string][] = [
    ["null", "Expected `bunvex.json` to contain an object"],
    ["[]", "Expected `bunvex.json` to contain an object"],
    ["5", "Expected `bunvex.json` to contain an object"],
    ['"x"', "Expected `bunvex.json` to contain an object"],
    ['{"functions":5}', "`functions` in `bunvex.json`: Expected string, received number"],
    ['{"functions":null}', "`functions` in `bunvex.json`: Expected string, received null"],
    ['{"functions":[]}', "`functions` in `bunvex.json`: Expected string, received array"],
    ['{"codegen":"x"}', "`codegen` in `bunvex.json`: Expected object, received string"],
    ['{"codegen":null}', "`codegen` in `bunvex.json`: Expected object, received null"],
    [
      '{"codegen":{"fileType":"invalid"}}',
      "`codegen.fileType` in `bunvex.json`: Invalid enum value. Expected 'ts' | 'js/dts', received 'invalid'",
    ],
    ['{"codegen":{"fileType":5}}', "`codegen.fileType` in `bunvex.json`: Expected 'ts' | 'js/dts', received number"],
    ['{"codegen":{"fileType":null}}', "`codegen.fileType` in `bunvex.json`: Expected 'ts' | 'js/dts', received null"],
    // The first issue, in the schema's order.
    ['{"functions":1,"codegen":{"fileType":"x"}}', "`functions` in `bunvex.json`: Expected string, received number"],
  ];
  for (const [json, message] of cases)
    test(`${json} → ${message}`, async () => {
      const app = tmp();
      write(app, { "bunvex.json": json });
      expect(() => codegenConfig(app)).toThrow(message);
      const { err, it } = io(app);
      expect(await main(["codegen", "--typecheck", "disable"], it)).toBe(1);
      expect(err).toEqual([`bunvex codegen: ${message}`]);
    });

  test("JSON that does not parse: Convex's line, then the parse error", async () => {
    const app = tmp();
    write(app, { "bunvex.json": "{bad json" });
    const { err, it } = io(app);
    expect(await main(["codegen", "--typecheck", "disable"], it)).toBe(1);
    expect(err[0]).toStartWith('bunvex codegen: Parsing "bunvex.json" failed\nSyntaxError: JSON Parse error:');
  });

  test("valid settings and other keys are read as before", () => {
    const app = tmp();
    write(app, { "bunvex.json": '{"functions":"src/fns","codegen":{"fileType":"ts"},"node":{"externalPackages":[]}}' });
    expect(codegenConfig(app).fileType).toBe("ts");
  });
});
