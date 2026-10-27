// Codegen (STUDY-36): the generated files (golden snapshots), module identifiers, the initial and final
// passes, and end to end — an app's `_generated/` typechecks with the real `tsc` against the bunvex packages,
// and a type error fails `bunvex codegen`.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatedFiles, importPath, moduleIdentifier, modulePaths, runCodegen } from "../src/codegen.ts";
import { codegenConfig, readProjectConfig } from "../src/deploy.ts";
import { main } from "../src/index.ts";
import { allowTsImports } from "./ts-imports.ts";

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
/**
 * A command run to its end in `cwd`: its exit code, stdout and stderr. Async, the pipes read alongside
 * `exited`: on a loaded CI runner a `Bun.spawnSync` here once sat until the test timeout killed its child
 * ("killed 1 dangling process"), though the child had done its work.
 */
const run = async (cmd: string[], cwd: string) => {
  const p = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
};
// What an app imports: the scoped packages (STUDY-40 L7), the generated files' default.
const SERVER = ["@bunvex", "server"].join("/");
const VALUES = ["@bunvex", "values"].join("/");

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
  test("@bunvex/* imports by default; bunvex/* for an app on the private aggregate `bunvex` (STUDY-40 L7)", () => {
    const text = (packages?: "bunvex" | "@bunvex") => {
      const g = generatedFiles(["a.ts"], { hasSchema: true, fileType: "js/dts", packages });
      return [...Object.values(g.server), ...Object.values(g.api), ...Object.values(g.dataModel)].join("\n");
    };
    for (const scoped of [text(), text("@bunvex")]) {
      expect(scoped).toContain(`from "${SERVER}"`);
      expect(scoped).toContain(`from "${VALUES}"`);
      expect(scoped).not.toMatch(/from "bunvex\//);
    }
    const aggregate = text("bunvex");
    expect(aggregate).toContain(`from ${JSON.stringify(SERVER.slice(1))}`);
    expect(aggregate).toContain(`from ${JSON.stringify(VALUES.slice(1))}`);
    expect(aggregate).not.toContain(`"${SERVER}"`);
    const dir = tmp();
    // No package.json: an app on the scoped packages, as every app is.
    expect(codegenConfig(dir).packages).toBe("@bunvex");
    const config = (pkg: Record<string, unknown>) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      return codegenConfig(dir).packages;
    };
    expect(config({ dependencies: { "@bunvex/server": "0.1.0" } })).toBe("@bunvex");
    expect(config({})).toBe("@bunvex");
    expect(config({ dependencies: { "left-pad": "1.0.0" } })).toBe("@bunvex");
    // This repository's examples depend on the aggregate, in any dependency field.
    expect(config({ dependencies: { bunvex: "workspace:*", "@bunvex/react-query": "workspace:*" } })).toBe("bunvex");
    expect(config({ devDependencies: { bunvex: "workspace:*" } })).toBe("bunvex");
    expect(config({ peerDependencies: { bunvex: "*" } })).toBe("bunvex");
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
  test("the initial pass keeps a component's component.ts, as Convex's; the final pass owns it", () => {
    const fns = join(tmp(), "component");
    write(fns, { "lib.ts": "export const x = 1;", "_generated/component.ts": "// final", "_generated/old.ts": "" });
    const r = runCodegen(fns, { fileType: "ts" }, { initial: true, keep: ["component.ts"] });
    expect(r.removed).toEqual(["old.ts"]);
    expect(readFileSync(join(fns, "_generated/component.ts"), "utf8")).toBe("// final");
    // Without `keep` (an app's own `_generated/`), it is a stale entry like any other.
    expect(runCodegen(fns, { fileType: "ts" }, { initial: true }).removed).toEqual(["component.ts"]);
  });

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

// An app installed as apps install bunvex: `@bunvex/server` and `@bunvex/values` (the workspace's), and
// `typescript`.
function appWithPackages(files: Record<string, string>) {
  const app = tmp();
  mkdirSync(join(app, "node_modules/@bunvex"), { recursive: true });
  for (const p of ["server", "values"])
    symlinkSync(resolve(import.meta.dir, "../..", p), join(app, "node_modules/@bunvex", p));
  symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(app, "node_modules/typescript"));
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ dependencies: { "@bunvex/server": "workspace:*", "@bunvex/values": "workspace:*" } }),
  );
  write(app, files);
  return app;
}

/** `codegen --init` in an app on the workspace's packages (see `allowTsImports`). */
async function initOnSources(app: string) {
  const r = io(app);
  expect(await main(["codegen", "--init", "--typecheck", "disable"], r.it)).toBe(0);
  allowTsImports(app);
  return r;
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
    const r = await initOnSources(app);
    expect(r.err).toContain("Wrote bunvex/tsconfig.json");
    expect(r.out[0]).toMatch(/^✔ Generated bunvex\/_generated/);
    expect(await main(["codegen", "--typecheck", "enable"], io(app).it)).toBe(0);
    // A table that is not in the schema, and the wrong arguments to a mutation.
    write(app, {
      "bunvex/bad.ts": `import { api } from "./_generated/api";
import { action, query } from "./_generated/server";
export const bad = query({ args: {}, handler: (ctx) => ctx.db.query("nope").collect() });
export const worse = action({ args: {}, handler: (ctx) => ctx.runMutation(api.messages.send, { author: "a" }) });`,
    });
    const bad = io(app);
    expect(await main(["codegen"], bad.it)).toBe(1);
    // As Convex's (STUDY-124): the failure and the hint on stderr, the compiler's errors on stdout, run with
    // `--pretty true` as Convex runs the compiler (STUDY-117): colored, `file:line:column`.
    expect(bad.err).toEqual([
      "✖ TypeScript typecheck via `tsc` failed.",
      "To ignore failing typecheck, use `--typecheck=disable`.",
    ]);
    const output = bad.out.join("\n");
    expect(Bun.stripANSI(output)).toContain(`bunvex/bad.ts:3:`);
    expect(output).toContain(`'"nope"'`);
    expect(Bun.stripANSI(output)).toContain(`bunvex/bad.ts:4:`);
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
    await initOnSources(app);
    expect(await main(["codegen", "--typecheck", "enable"], io(app).it)).toBe(0);
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
    const probe = await run(["bun", "complete.mjs"], app);
    expect(probe.code).toBe(0);
    const completions = JSON.parse(probe.out) as { plain: string[]; generated: string[] };
    expect(completions.plain).toEqual(["_scheduled_functions", "_storage"]);
    expect(completions.generated).toEqual(["_scheduled_functions", "_storage", "messages"]);
    write(app, { "bunvex/typo.ts": `import { v } from "./_generated/server";\nexport const bad = v.id("mesages");` });
    const strict = io(app);
    expect(await main(["codegen"], strict.it)).toBe(1);
    expect(Bun.stripANSI(strict.out.join("\n"))).toContain(`bunvex/typo.ts:2:`);
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
    await initOnSources(app);
    expect(await main(["codegen", "--typecheck", "enable"], io(app).it)).toBe(0);
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

// STUDY-116: Convex's other codegen flags. `--dry-run` and `--debug` print what Convex's `writeFormattedFile`
// prints (lib/codegen.ts), `--commonjs` adds `api_cjs`, the deployment's flags are ignored (DV-384), the
// components' work since STUDY-156 (DV-385 closed) and `--system-udfs` is not an option (DV-386).
describe("bunvex codegen --dry-run, --debug, --commonjs and the other flags (STUDY-116)", () => {
  const ALL = ["dataModel.d.ts", "server.js", "server.d.ts", "api.js", "api.d.ts"];
  /** Every file under `dir`, with its content: what a run must leave alone. */
  const snapshot = (dir: string): Record<string, string> => {
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, e.name);
        if (e.isDirectory()) walk(path);
        else files[path.slice(dir.length)] = readFileSync(path, "utf8");
      }
    };
    walk(dir);
    return files;
  };

  test("--dry-run writes nothing and prints each file that would change, then each stale entry", async () => {
    const app = tmp();
    write(app, { "bunvex/messages.ts": "export const x = 1;", "bunvex/_generated/old/stale.js": "// old" });
    const before = snapshot(app);
    const r = io(app);
    expect(await main(["codegen", "--dry-run", "--typecheck", "disable"], r.it)).toBe(0);
    expect(r.out).toEqual([
      ...ALL.map((f) => `Command would write file: bunvex/_generated/${f}`),
      "Command would delete file: bunvex/_generated/old/stale.js",
      "Command would delete directory: bunvex/_generated/old",
    ]);
    expect(r.err).toEqual([]);
    expect(snapshot(app)).toEqual(before);
    // After a real run nothing would change; then only what a new module changes.
    expect(await main(["codegen", "--typecheck", "disable"], io(app).it)).toBe(0);
    const same = io(app);
    expect(await main(["codegen", "--dry-run", "--typecheck", "disable"], same.it)).toBe(0);
    expect(same.out).toEqual([]);
    write(app, { "bunvex/more.ts": "export const y = 1;" });
    const after = snapshot(app);
    const changed = io(app);
    expect(await main(["codegen", "--dry-run", "--typecheck", "disable"], changed.it)).toBe(0);
    expect(changed.out).toEqual(["Command would write file: bunvex/_generated/api.d.ts"]);
    expect(snapshot(app)).toEqual(after);
  });

  // Convex's `convex/tsconfig.json` (npm-packages/convex/src/cli/codegen_templates/tsconfig.ts, after its prettier
  // pass: no trailing comma, a final newline), with bunvex for Convex. No `allowImportingTsExtensions`: the
  // published packages ship `.d.ts` files (STUDY-167).
  test("--init writes Convex's tsconfig.json, in bunvex's name, and keeps one that exists", async () => {
    const app = tmp();
    expect(await main(["codegen", "--init", "--typecheck", "disable"], io(app).it)).toBe(0);
    expect(readFileSync(join(app, "bunvex/tsconfig.json"), "utf8")).toBe(`{
  /* This TypeScript project config describes the environment that
   * bunvex functions run in and is used to typecheck them.
   * You can modify it, but some settings are required to use bunvex.
   */
  "compilerOptions": {
    /* These settings are not required by bunvex and can be modified. */
    "allowJs": true,
    "strict": true,
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,

    /* These compiler options are required by bunvex */
    "target": "ESNext",
    "lib": ["ES2023", "dom"],
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["./**/*"],
  "exclude": ["./_generated"]
}
`);
    write(app, { "bunvex/tsconfig.json": "{}" });
    const again = io(app);
    expect(await main(["codegen", "--init", "--typecheck", "disable"], again.it)).toBe(0);
    expect(again.err).not.toContain("Wrote bunvex/tsconfig.json");
    expect(readFileSync(join(app, "bunvex/tsconfig.json"), "utf8")).toBe("{}");
  });

  test("--init --dry-run lists README.md and tsconfig.json without writing them", async () => {
    const app = tmp();
    const r = io(app);
    expect(await main(["codegen", "--init", "--dry-run", "--typecheck", "disable"], r.it)).toBe(0);
    expect(r.out.slice(0, 2)).toEqual([
      "Command would write file: bunvex/README.md",
      "Command would write file: bunvex/tsconfig.json",
    ]);
    expect(existsSync(join(app, "bunvex/README.md"))).toBe(false);
    expect(existsSync(join(app, "bunvex/tsconfig.json"))).toBe(false);
  });

  test("--debug prints every file as `# <absolute path>` and its contents, and writes or removes nothing", async () => {
    const app = tmp();
    write(app, { "bunvex/messages.ts": "export const x = 1;", "bunvex/_generated/stale.js": "// old" });
    expect(await main(["codegen", "--typecheck", "disable"], io(app).it)).toBe(0);
    write(app, { "bunvex/_generated/stale.js": "// old", "bunvex/more.ts": "export const y = 1;" });
    const before = snapshot(app);
    const r = io(app);
    expect(await main(["codegen", "--debug", "--typecheck", "disable"], r.it)).toBe(0);
    const files = generatedFiles(["messages.ts", "more.ts"], { hasSchema: false, fileType: "js/dts" });
    const contents: Record<string, string> = { ...files.dataModel, ...files.server, ...files.api };
    // Unchanged files too: the debug output is the whole of `_generated/`.
    expect(r.out).toEqual(ALL.flatMap((f) => [`# ${join(app, "bunvex/_generated", f)}`, contents[f]!]));
    expect(snapshot(app)).toEqual(before);
  });

  test("--url and --admin-key are accepted and change nothing", async () => {
    const app = tmp();
    write(app, { "bunvex/messages.ts": "export const x = 1;" });
    const r = io(app);
    expect(
      await main(["codegen", "--url", "http://127.0.0.1:1", "--admin-key=nope", "--typecheck", "disable"], r.it),
    ).toBe(0);
    expect(r.out).toEqual([`✔ Generated bunvex/_generated (${ALL.join(", ")})`]);
    const missing = io(app);
    expect(await main(["codegen", "--url"], missing.it)).toBe(1);
    expect(missing.err).toEqual(["error: option '--url <url>' argument missing"]);
  });

  test("--component-dir needs its path (STUDY-156 tests the rest); --system-udfs is not an option", async () => {
    const app = tmp();
    const missing = io(app);
    expect(await main(["codegen", "--component-dir"], missing.it)).toBe(1);
    expect(missing.err).toEqual(["error: option '--component-dir <path>' argument missing"]);
    const udfs = io(app);
    expect(await main(["codegen", "--system-udfs"], udfs.it)).toBe(1);
    expect(udfs.err[0]).toStartWith("error: unknown option '--system-udfs'");
    expect(existsSync(join(app, "bunvex"))).toBe(false);
  });

  test("--commonjs (or generateCommonJSApi) writes api_cjs.cjs, which loads with require()", async () => {
    const app = appWithPackages({ "bunvex/messages.ts": "export const list = 1;" });
    const r = io(app);
    expect(await main(["codegen", "--commonjs", "--typecheck", "disable"], r.it)).toBe(0);
    expect(r.out).toEqual([`✔ Generated bunvex/_generated (${ALL.join(", ")}, api_cjs.cjs, api_cjs.d.cts)`]);
    const gen = join(app, "bunvex/_generated");
    expect(readFileSync(join(gen, "api_cjs.d.cts"), "utf8")).toBe(readFileSync(join(gen, "api.d.ts"), "utf8"));
    expect(readFileSync(join(gen, "api_cjs.cjs"), "utf8")).toContain(`require(${JSON.stringify(SERVER)})`);
    const probe = await run(
      [
        "bun",
        "-e",
        `const { api, internal } = require("./bunvex/_generated/api_cjs.cjs");
const { getFunctionName } = require(${JSON.stringify(SERVER)});
console.log(JSON.stringify([getFunctionName(api.messages.list), getFunctionName(internal.a.b)]));`,
      ],
      app,
    );
    expect(probe.err).toBe("");
    expect(JSON.parse(probe.out)).toEqual(["messages:list", "a:b"]);
    // Without the flag, a run removes them again; bunvex.json's generateCommonJSApi writes them, in both passes.
    expect(await main(["codegen", "--typecheck", "disable"], io(app).it)).toBe(0);
    expect(existsSync(join(gen, "api_cjs.cjs"))).toBe(false);
    write(app, { "bunvex.json": '{"generateCommonJSApi":true}' });
    expect(codegenConfig(app).commonjs).toBe(true);
    expect(runCodegen(join(app, "bunvex"), codegenConfig(app), { initial: true }).written.sort()).toEqual([
      "api_cjs.cjs",
      "api_cjs.d.cts",
    ]);
    expect(readFileSync(join(gen, "api_cjs.d.cts"), "utf8")).toContain("AnyApi");
    expect(await main(["codegen", "--typecheck", "disable"], io(app).it)).toBe(0);
    expect(readFileSync(join(gen, "api_cjs.d.cts"), "utf8")).toContain("typeof messages");
    // The initial pass always rewrites api_cjs.cjs (as api.js), and keeps the typed declarations.
    write(app, { "bunvex/_generated/api_cjs.cjs": "// stale" });
    expect(runCodegen(join(app, "bunvex"), codegenConfig(app), { initial: true }).written).toEqual(["api_cjs.cjs"]);
    expect(readFileSync(join(gen, "api_cjs.cjs"), "utf8")).toContain("module.exports");
    // With fileType ts the flag writes nothing more, as Convex's.
    write(app, { "bunvex.json": '{"codegen":{"fileType":"ts"}}' });
    const ts = io(app);
    expect(await main(["codegen", "--commonjs", "--typecheck", "disable"], ts.it)).toBe(0);
    expect(readdirSync(gen).sort()).toEqual(["api.ts", "dataModel.ts", "server.ts"]);
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
    ['{"generateCommonJSApi":"yes"}', "`generateCommonJSApi` in `bunvex.json`: Expected boolean, received string"],
    [
      '{"generateCommonJSApi":true,"codegen":{"fileType":"ts"}}',
      '`generateCommonJSApi` in `bunvex.json`: Cannot use `generateCommonJSApi: true` with `codegen.fileType: "ts"`. CommonJS modules require JavaScript generation. Either set `codegen.fileType: "js/dts"` or remove `generateCommonJSApi`.',
    ],
    // The first issue, in the schema's order.
    ['{"functions":1,"codegen":{"fileType":"x"}}', "`functions` in `bunvex.json`: Expected string, received number"],
    // `node` and `bundler` (STUDY-145), from Convex 1.46's CLI the same way.
    ['{"node":5}', "`node` in `bunvex.json`: Expected object, received number"],
    ['{"node":null}', "`node` in `bunvex.json`: Expected object, received null"],
    ['{"node":[]}', "`node` in `bunvex.json`: Expected object, received array"],
    ['{"node":{"nodeVersion":20}}', "`node.nodeVersion` in `bunvex.json`: Expected string, received number"],
    ['{"node":{"nodeVersion":null}}', "`node.nodeVersion` in `bunvex.json`: Expected string, received null"],
    ['{"bundler":5}', "`bundler` in `bunvex.json`: Expected object, received number"],
    ['{"bundler":null}', "`bundler` in `bunvex.json`: Expected object, received null"],
    ['{"bundler":[]}', "`bundler` in `bunvex.json`: Expected object, received array"],
    [
      '{"bundler":{"includeSourcesContent":"yes"}}',
      "`bundler.includeSourcesContent` in `bunvex.json`: Expected boolean, received string",
    ],
    [
      '{"bundler":{"includeSourcesContent":null}}',
      "`bundler.includeSourcesContent` in `bunvex.json`: Expected boolean, received null",
    ],
    ['{"functions":1,"node":{"nodeVersion":1}}', "`functions` in `bunvex.json`: Expected string, received number"],
    [
      '{"node":{"nodeVersion":1},"codegen":{"fileType":"x"}}',
      "`node.nodeVersion` in `bunvex.json`: Expected string, received number",
    ],
    [
      '{"bundler":{"includeSourcesContent":1},"codegen":{"fileType":"x"}}',
      "`codegen.fileType` in `bunvex.json`: Invalid enum value. Expected 'ts' | 'js/dts', received 'x'",
    ],
    // `node.externalPackages` (STUDY-148), from Convex 1.46's CLI the same way.
    ['{"node":{"externalPackages":"x"}}', "`node.externalPackages` in `bunvex.json`: Expected array, received string"],
    ['{"node":{"externalPackages":null}}', "`node.externalPackages` in `bunvex.json`: Expected array, received null"],
    ['{"node":{"externalPackages":{}}}', "`node.externalPackages` in `bunvex.json`: Expected array, received object"],
    [
      '{"node":{"externalPackages":[1]}}',
      "`node.externalPackages.0` in `bunvex.json`: Expected string, received number",
    ],
    [
      '{"node":{"externalPackages":[null]}}',
      "`node.externalPackages.0` in `bunvex.json`: Expected string, received null",
    ],
    [
      '{"node":{"externalPackages":[[]]}}',
      "`node.externalPackages.0` in `bunvex.json`: Expected string, received array",
    ],
    [
      '{"node":{"externalPackages":["a",{}]}}',
      "`node.externalPackages.1` in `bunvex.json`: Expected string, received object",
    ],
    [
      '{"node":{"externalPackages":["tiny-asset",2]}}',
      "`node.externalPackages.1` in `bunvex.json`: Expected string, received number",
    ],
    // `externalPackages` before `nodeVersion`, and after `functions`.
    [
      '{"node":{"nodeVersion":1,"externalPackages":"x"}}',
      "`node.externalPackages` in `bunvex.json`: Expected array, received string",
    ],
    ['{"functions":1,"node":{"externalPackages":1}}', "`functions` in `bunvex.json`: Expected string, received number"],
    [
      '{"typescriptCompiler":"x","generateCommonJSApi":"y"}',
      "`generateCommonJSApi` in `bunvex.json`: Expected boolean, received string",
    ],
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
    // Any string passes here, as in Convex's CLI: the deployment checks the version (STUDY-145).
    write(app, { "bunvex.json": '{"node":{"nodeVersion":"16"},"bundler":{"includeSourcesContent":true}}' });
    expect(readProjectConfig(app)).toEqual({ node: { nodeVersion: "16" }, bundler: { includeSourcesContent: true } });
    // `node.externalPackages` (STUDY-148): any list of strings, `"*"` among them.
    write(app, { "bunvex.json": '{"node":{"externalPackages":["*","sharp","@scope/pkg"],"nodeVersion":"22"}}' });
    expect(readProjectConfig(app)).toEqual({
      node: { externalPackages: ["*", "sharp", "@scope/pkg"], nodeVersion: "22" },
    });
  });
});
