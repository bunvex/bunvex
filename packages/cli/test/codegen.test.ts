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
    const output = bad.err.join("\n");
    expect(output).toContain(`bunvex/bad.ts(3,`);
    expect(output).toContain(`'"nope"'`);
    expect(output).toContain(`bunvex/bad.ts(4,`);
    expect(output).toContain("To ignore failing typecheck, use `--typecheck=disable`.");
    expect(await main(["codegen", "--typecheck=disable"], io(app).it)).toBe(0);
  }, 120_000);

  test("without a tsconfig, try skips the typecheck and enable fails", async () => {
    const app = tmp();
    write(app, { "bunvex/a.ts": "export const x = 1;" });
    const r = io(app);
    expect(await main(["codegen"], r.it)).toBe(0);
    expect(r.err.join("\n")).toContain("Found no bunvex/tsconfig.json");
    expect(await main(["codegen", "--typecheck", "enable"], io(app).it)).toBe(1);
    expect(await main(["codegen", "--typecheck", "sometimes"], io(app).it)).toBe(2);
  });
});
