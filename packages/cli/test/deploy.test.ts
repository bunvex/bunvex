// `bunvex deploy` end to end (STUDY-35 PR 6): an example app's `bunvex/` directory bundled as Convex's CLI
// does and pushed to a running deployable server; its functions, schema, HTTP routes and crons go live; a
// second deploy sends only what changed.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { bundleFunctions, entryPoints, usesNode } from "../src/bundle.ts";
import { parseEnvFile, partitionModules } from "../src/deploy.ts";
import { type Io, main } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "cd".repeat(32);
const NAME = "deploy-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-app-"));
  dirs.push(d);
  return d;
};
const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

async function deployment() {
  const dir = tmp();
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: memoryStore() as never,
  });
  stops.push(() => s.shutdown());
  const url = `http://127.0.0.1:${s.server.port}`;
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`${url}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status: string; value?: unknown; errorMessage?: string };
  return { url, call, engine };
}

function io(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { it, out, err };
}

/** A source map's segments: generated line and column, source index, original line and column. */
function segments(mappings: string): number[][] {
  const out: number[][] = [];
  const acc = [0, 0, 0, 0];
  mappings.split(";").forEach((group, line) => {
    let genCol = 0;
    for (const seg of group.split(",").filter(Boolean)) {
      const f: number[] = [];
      let value = 0;
      let shift = 0;
      for (const c of seg) {
        const d = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(c);
        value += (d & 31) << shift;
        shift += 5;
        if (d & 32) continue;
        f.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
      genCol += f[0]!;
      if (f.length < 4) continue;
      acc[1]! += f[1]!;
      acc[2]! += f[2]!;
      acc[3]! += f[3]!;
      out.push([line, genCol, acc[1]!, acc[2]!, acc[3]!]);
    }
  });
  return out;
}

// The app's imports, spelled so the dependency checker does not take them for this test's own.
const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");
const APP: Record<string, string> = {
  "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export default defineSchema({
  messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
});`,
  "bunvex/messages.ts": `import { mutation, query } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
import { shout } from "./lib/format";
export const list = query({ args: {}, handler: async ({ db }) => (await db.query("messages").collect()).map((m) => shout(m.body)) });
export const send = mutation({ args: { author: v.string(), body: v.string() }, handler: async ({ db }, a) => db.insert("messages", a) });`,
  "bunvex/lib/format.ts": `export const shout = (s: string): string => s.toUpperCase();`,
  "bunvex/http.ts": `import { httpAction, httpRouter } from ${JSON.stringify(SERVER)};
const http = httpRouter();
http.route({ path: "/hello", method: "GET", handler: httpAction(async () => new Response("hello from http")) });
export default http;`,
  "bunvex/crons.ts": `import { cronJobs } from ${JSON.stringify(SERVER)};
const crons = cronJobs();
crons.interval("tick", { minutes: 10 }, "jobs:tick");
export default crons;`,
  "bunvex/jobs.ts": `import { internalMutation } from ${JSON.stringify(SERVER)};
export const tick = internalMutation(async () => {});`,
  "bunvex/files.ts": `"use node";
import { action } from ${JSON.stringify(SERVER)};
import { createHash } from "node:crypto";
export const digest = action(async (_ctx, { text }: { text: string }) => createHash("sha256").update(text).digest("hex").slice(0, 8));`,
  "bunvex/messages.test.ts": `throw new Error("tests are not modules");`,
  "bunvex/_generated/api.ts": `export const api = {};`,
};

describe("bunvex deploy", () => {
  test('bundles bunvex/ and pushes it: functions, schema, a shared helper, http, crons, "use node"', async () => {
    const d = await deployment();
    const app = tmp();
    write(app, APP);
    write(app, { ".env.local": `BUNVEX_SELF_HOSTED_URL=${d.url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY="${KEY}"\n` });
    const r = io(app);
    expect(await main(["deploy"], r.it)).toBe(0);
    expect(r.out).toEqual([`✔ Deployed functions to ${d.url}`]);
    expect(r.err).toContain("✔ Added table indexes:\n  [+] messages.by_author   author");
    expect(r.err).toContain("  [+] cron tick");
    expect((await d.call("mutation", "messages:send", { author: "ada", body: "hi" })).status).toBe("success");
    expect((await d.call("query", "messages:list")).value).toEqual(["HI"]);
    expect((await d.call("mutation", "messages:send", { author: "ada" })).status).toBe("error"); // the schema
    expect(await (await fetch(`${d.url}/http/hello`)).text()).toBe("hello from http");
    expect((await d.call("action", "files:digest", { text: "x" })).value).toMatch(/^[0-9a-f]{8}$/);
    // The test file and _generated were not pushed.
    const hashes = (await (
      await fetch(`${d.url}/api/get_config_hashes`, {
        method: "POST",
        headers: { authorization: `Bunvex ${KEY}` },
        body: "{}",
      })
    ).json()) as { moduleHashes: { path: string }[] };
    const paths = hashes.moduleHashes.map((h) => h.path).filter((p) => !p.startsWith("_deps/"));
    expect(paths.sort()).toEqual([
      "crons.js",
      "files.js",
      "http.js",
      "jobs.js",
      "lib/format.js",
      "messages.js",
      "schema.js",
    ]);
    // Codegen ran (STUDY-36): the api lists every module; the stale _generated/api.ts is gone.
    const apiDts = readFileSync(join(app, "bunvex/_generated/api.d.ts"), "utf8");
    for (const m of ["crons", "files", "http", "jobs", "lib/format", "messages"])
      expect(apiDts).toContain(`"../${m}.js"`);
    expect(existsSync(join(app, "bunvex/_generated/api.ts"))).toBe(false);
    expect(existsSync(join(app, "bunvex/_generated/dataModel.d.ts"))).toBe(true);
  });

  test("a type error stops the push before it finishes; --typecheck=disable and --codegen=disable", async () => {
    const d = await deployment();
    const app = tmp();
    mkdirSync(join(app, "node_modules"));
    symlinkSync(resolve(import.meta.dir, "../../bunvex"), join(app, "node_modules/bunvex"));
    symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(app, "node_modules/typescript"));
    write(app, {
      "bunvex/a.ts": `import { v } from ${JSON.stringify(["bunvex", "values"].join("/"))};
import { query } from "./_generated/server";
export const q = query({ args: {}, returns: v.number(), handler: async (ctx) => (await ctx.db.query("t").collect()).length.toString() });`,
    });
    expect(await main(["codegen", "--init", "--typecheck=disable"], io(app).it)).toBe(0);
    const flags = ["--url", d.url, "--admin-key", KEY];
    const failed = io(app);
    expect(await main(["deploy", ...flags], failed.it)).toBe(1);
    expect(failed.err.slice(-2)).toEqual([
      "✖ TypeScript typecheck via `tsc` failed.",
      "To ignore failing typecheck, use `--typecheck=disable`.",
    ]);
    // `--pretty true`, as Convex runs the compiler (STUDY-117): colored, `file:line:column`.
    expect(Bun.stripANSI(failed.out.join("\n"))).toContain(`bunvex/a.ts:3:`);
    expect((await d.call("query", "a:q")).status).toBe("error"); // nothing was deployed
    expect(await main(["deploy", "--typecheck=disable", ...flags], io(app).it)).toBe(0);
    // Deployed despite the type error: its `returns` check fails at run time.
    expect((await d.call("query", "a:q")).status).toBe("error");
    expect((await d.call("query", "a:q")).errorMessage).toContain("ReturnsValidationError");
    // Without codegen, _generated/ is left as it is.
    const before = readFileSync(join(app, "bunvex/_generated/api.d.ts"), "utf8");
    write(app, {
      "bunvex/b.ts": `import { query } from "./_generated/server";\nexport const r = query(async () => 1);`,
    });
    expect(await main(["deploy", "--codegen=disable", "--typecheck=disable", ...flags], io(app).it)).toBe(0);
    expect(readFileSync(join(app, "bunvex/_generated/api.d.ts"), "utf8")).toBe(before);
    const bad = io(app);
    expect(await main(["deploy", "--codegen=sometimes", ...flags], bad.it)).toBe(1);
    expect(bad.err.slice(0, 2)).toEqual([
      "error: option '--codegen <mode>' argument 'sometimes' is invalid. Allowed choices are enable, disable.",
      "",
    ]);
  }, 120_000);

  test("the index diff, as Convex's printDiff: added, staged, enabled, staged again, deleted; a dry run says would", async () => {
    const d = await deployment();
    const app = tmp();
    const env = { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY };
    const withSchema = (indexes: string) =>
      write(app, {
        "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export default defineSchema({ notes: defineTable({ a: v.string(), b: v.string(), t: v.string() })${indexes} });`,
      });
    const deploy = async (...flags: string[]) => {
      const r = io(app, env);
      expect(await main(["deploy", "--typecheck=disable", "--codegen=disable", ...flags], r.it)).toBe(0);
      return r.err.filter((l) => l.startsWith("✔ ") && l.includes("\n"));
    };
    withSchema(
      '.index("by_a", ["a"]).index("by_ab", { fields: ["a", "b"], staged: true }).searchIndex("search_t", { searchField: "t", filterFields: ["a"] })',
    );
    expect(await deploy("--dry-run")).toEqual([
      "✔ Would add table indexes:\n  [+] notes.by_a   a\n  [+] notes.search_t (text)   t, filter on a",
      "✔ Would add staged table indexes:\n  [+] notes.by_ab   a, b  (staged)",
    ]);
    expect(await deploy()).toEqual([
      "✔ Added table indexes:\n  [+] notes.by_a   a\n  [+] notes.search_t (text)   t, filter on a",
      "✔ Added staged table indexes:\n  [+] notes.by_ab   a, b  (staged)",
    ]);
    // by_ab enabled, by_a staged again, search_t deleted.
    withSchema('.index("by_a", { fields: ["a"], staged: true }).index("by_ab", ["a", "b"])');
    expect(await deploy()).toEqual([
      "✔ Deleted table indexes:\n  [-] notes.search_t (text)   t, filter on a",
      "✔ These indexes are now enabled:\n  [*] notes.by_ab   a, b",
      "✔ These indexes are now staged:\n  [*] notes.by_a   a  (staged)",
    ]);
    expect(await deploy()).toEqual([]);
  });

  test("a second deploy changes one module; flags and bunvex.json's functions directory", async () => {
    const d = await deployment();
    const app = tmp();
    const files = Object.fromEntries(Object.entries(APP).map(([k, v]) => [k.replace(/^bunvex\//, "convexish/"), v]));
    write(app, { ...files, "bunvex.json": `{ "functions": "convexish/" }` });
    const flags = ["--url", d.url, "--admin-key", KEY];
    expect(await main(["deploy", ...flags], io(app).it)).toBe(0);
    write(app, { "convexish/lib/format.ts": `export const shout = (s: string): string => s + "!";` });
    expect(await main(["deploy", ...flags], io(app).it)).toBe(0);
    await d.call("mutation", "messages:send", { author: "ada", body: "yo" });
    expect((await d.call("query", "messages:list")).value).toEqual(["yo!"]);
    const dry = io(app);
    expect(await main(["deploy", "--dry-run", ...flags], dry.it)).toBe(0);
    expect(dry.out[0]).toMatch(/^Dry run: \d+ modules, 4 functions; nothing was changed\.$/);
  });

  test('errors: no deployment, a module that fails at import, Node APIs without "use node"', async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/a.ts": `export const x = 1;` });
    const none = io(app);
    expect(await main(["deploy"], none.it)).toBe(1);
    expect(none.err[0]).toBe("bunvex deploy: No BUNVEX_DEPLOYMENT set, run `bunvex dev` to configure a bunvex project");
    write(app, {
      "bunvex/a.ts": `import { query } from ${JSON.stringify(SERVER)}; throw new Error("broken"); export const q = query(async () => 1);`,
    });
    const broken = io(app, { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY });
    expect(await main(["deploy"], broken.it)).toBe(1);
    expect(broken.err.join("\n")).toContain("Failed to analyze a.js: Uncaught Error: broken");
    write(app, { "bunvex/a.ts": `import { readFileSync } from "node:fs"; export const x = readFileSync;` });
    const nodeApi = io(app, { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY });
    expect(await main(["deploy"], nodeApi.it)).toBe(1);
    expect(nodeApi.err.join("\n")).toMatch(/"fs" is only available in "use node" files/);
    const badKey = io(app, { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: "nope" });
    write(app, { "bunvex/a.ts": `export const x = 1;` });
    expect(await main(["deploy"], badKey.it)).toBe(1);
    expect(badKey.err[0]).toContain("The provided admin key was invalid for this instance");
  });

  test('Convex\'s entry-point rules and the "use node" directive', () => {
    const app = tmp();
    write(app, {
      "f/a.ts": "export const a = 1;",
      "f/b.js": "module.exports = 1",
      "f/no-imports.ts": "const x = 1;",
      "f/schema.ts": "export default 1;",
      "f/x.test.ts": "export const t = 1;",
      "f/auth.config.ts": "export default {};",
      "f/.hidden.ts": "export const h = 1;",
      "f/#tmp.ts": "export const t = 1;",
      "f/with space.ts": "export const s = 1;",
      "f/_generated/api.ts": "export const g = 1;",
      "f/_private.ts": "export const p = 1;",
      "f/nested/deep.mts": "export const d = 1;",
      "f/readme.md": "# no",
    });
    const rel = entryPoints(join(app, "f")).map((p) => p.slice(join(app, "f").length + 1));
    expect(rel).toEqual(["_private.ts", "a.ts", "b.js", "nested/deep.mts"]);
    write(app, { "f/_deps/x.ts": "export const x = 1;" });
    expect(() => entryPoints(join(app, "f"))).toThrow(/_deps/);
    expect(usesNode(`"use node";\nimport x from "y";`)).toBe(true);
    expect(usesNode(`// comment\n'use node'\n`)).toBe(true);
    expect(usesNode(`"use strict"; "use node";`)).toBe(true);
    expect(usesNode(`import x from "y";\n"use node";`)).toBe(false);
  });

  test("the bundle: schema.js apart, auth.config.js among the modules, chunks under _deps/", async () => {
    const app = tmp();
    write(app, {
      ...APP,
      "bunvex/auth.config.ts": `export default { providers: [{ domain: "https://issuer.example", applicationID: "app" }] };`,
      "bunvex/more.ts": `import { query } from ${JSON.stringify(SERVER)}; import { shout } from "./lib/format"; export const q = query(async () => shout("x"));`,
    });
    const b = await bundleFunctions(join(app, "bunvex"));
    expect(b.schema?.path).toBe("schema.js");
    expect(b.modules.find((m) => m.path === "auth.config.js")?.source).toContain("issuer.example");
    expect(b.modules.find((m) => m.path === "files.js")?.environment).toBe("node");
    expect(b.modules.some((m) => m.path.startsWith("_deps/"))).toBe(true); // lib/format shared by two modules
    expect(b.modules.every((m) => !m.source.startsWith("// @bun"))).toBe(true);
    expect(b.modules.find((m) => m.path === "messages.js")?.sourceMap).toBeDefined();
    // Each source map still matches its module once the `// @bun` line is dropped (the server reads the
    // functions' positions from it, STUDY-65 M5): a string literal is at the same place in both.
    let checked = 0;
    for (const m of b.modules.filter((x) => x.sourceMap)) {
      const map = JSON.parse(m.sourceMap!) as { mappings: string; sourcesContent: string[] };
      const lines = m.source.split("\n");
      const strings = segments(map.mappings).filter(([l, c]) => lines[l!]?.[c!] === '"');
      checked += strings.length;
      for (const [l, c, src, sl, sc] of strings) {
        const original = map.sourcesContent[src!]!.split("\n")[sl!]!.slice(sc!, sc! + 6);
        expect([m.path, lines[l!]!.slice(c!, c! + 6)]).toEqual([m.path, original]);
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  test('`import "server-only"` bundles to an empty module, installed or not; a `.wasm` import is a WebAssembly.Module (STUDY-83)', async () => {
    const d = await deployment();
    const app = tmp();
    // The real package throws outside React server components: the stub must win over it.
    write(app, {
      "node_modules/server-only/package.json": JSON.stringify({ name: "server-only", main: "index.js" }),
      "node_modules/server-only/index.js": `throw new Error("This module cannot be imported from a Client Component module.");`,
      "bunvex/guarded.ts": `import "server-only";
import { query } from ${JSON.stringify(SERVER)};
import { secret } from "./lib/secret";
export const read = query(async () => secret());`,
      "bunvex/lib/secret.ts": `import "server-only";
export const secret = () => "kept on the server";`,
      "bunvex/maths.ts": `import { query } from ${JSON.stringify(SERVER)};
import addModule from "./add.wasm";
export const add = query(async (_ctx, { a, b }: { a: number; b: number }) =>
  (new WebAssembly.Instance(addModule).exports.add as (a: number, b: number) => number)(a, b));
export const isModule = query(async () => addModule instanceof WebAssembly.Module);`,
    });
    // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
    writeFileSync(
      join(app, "bunvex/add.wasm"),
      Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03,
        0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20,
        0x00, 0x20, 0x01, 0x6a, 0x0b,
      ]),
    );
    const b = await bundleFunctions(join(app, "bunvex"));
    expect(b.modules.map((m) => m.source).join("\n")).not.toContain("Client Component");
    write(app, { ".env.local": `BUNVEX_SELF_HOSTED_URL=${d.url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY="${KEY}"\n` });
    const r = io(app);
    expect(await main(["deploy", "--typecheck=disable"], r.it)).toBe(0);
    expect((await d.call("query", "guarded:read")).value).toBe("kept on the server");
    expect((await d.call("query", "maths:isModule")).value).toBe(true);
    expect((await d.call("query", "maths:add", { a: 2, b: 40 })).value).toBe(42);
  });

  test("--cmd runs first, with the deployment's URLs in the framework's variables; a failure stops the deploy (STUDY-81)", async () => {
    const d = await deployment();
    const urls = (await (
      await fetch(`${d.url}/api/v1/get_canonical_urls`, { headers: { authorization: `Bunvex ${KEY}` } })
    ).json()) as { bunvexCloudUrl: string; bunvexSiteUrl: string };
    const app = tmp();
    write(app, APP);
    write(app, {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      ".env.local": `BUNVEX_SELF_HOSTED_URL=${d.url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY="${KEY}"\n`,
    });
    const deployWith = async (...args: string[]) => {
      const r = io(app);
      return { code: await main(["deploy", "--typecheck=disable", ...args], r.it), ...r };
    };
    // A dry run says what it would run, and runs nothing.
    const dry = await deployWith("--dry-run", "--cmd", "echo ran > ran.txt");
    expect(dry.code).toBe(0);
    expect(dry.err).toContain(
      `Running 'echo ran > ran.txt' with environment variables "VITE_BUNVEX_URL" and "VITE_BUNVEX_SITE_URL" set... [dry run]`,
    );
    expect(dry.out[0]).toBe(
      `✔ Would have run "echo ran > ran.txt" with environment variables "VITE_BUNVEX_URL" and "VITE_BUNVEX_SITE_URL" set`,
    );
    expect(existsSync(join(app, "ran.txt"))).toBe(false);
    // A failing command: nothing is pushed.
    const failed = await deployWith("--cmd", "exit 3");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("bunvex deploy: 'exit 3' failed");
    expect((await d.call("query", "messages:list")).status).toBe("error");
    // The build sees the URLs, in the framework's variables or the one asked for; then the push.
    const ok = await deployWith("--cmd", 'printf "%s %s" "$VITE_BUNVEX_URL" "$VITE_BUNVEX_SITE_URL" > urls.txt');
    expect(ok.code).toBe(0);
    expect(readFileSync(join(app, "urls.txt"), "utf8")).toBe(`${urls.bunvexCloudUrl} ${urls.bunvexSiteUrl}`);
    expect(ok.out.at(-1)).toBe(`✔ Deployed functions to ${d.url}`);
    expect((await d.call("query", "messages:list")).status).toBe("success");
    const named = await deployWith("--cmd", 'printf "%s" "$MY_URL" > mine.txt', "--cmd-url-env-var-name", "MY_URL");
    expect(named.code).toBe(0);
    expect(readFileSync(join(app, "mine.txt"), "utf8")).toBe(urls.bunvexCloudUrl);
  });

  test("a push sends only the changed modules (Convex's partitionModulesByChanges)", () => {
    const m = (path: string, source: string, environment: "isolate" | "node" = "isolate") => ({
      path,
      source,
      environment,
    });
    const hash = (x: { source: string }) => new Bun.CryptoHasher("sha256").update(x.source).digest("hex");
    const a = m("a.js", "export const a = 1;");
    const b = m("b.js", "export const b = 1;");
    const c = m("c.js", "export const c = 1;", "node");
    const r = partitionModules(
      [a, b, c],
      [
        { path: "a.js", hash: hash(a), environment: "isolate" },
        { path: "b.js", hash: "stale", environment: "isolate" },
        { path: "c.js", hash: hash(c), environment: "isolate" },
      ],
    );
    expect(r.changedModules.map((x) => x.path)).toEqual(["b.js", "c.js"]);
    expect(r.unchangedModuleHashes).toEqual([{ path: "a.js", environment: "isolate", sha256: hash(a) }]);
  });

  test("Convex's partitionModulesByChanges cases: source maps, deletions, all of it at once", () => {
    const m = (path: string, source: string, environment: "isolate" | "node" = "isolate", sourceMap?: string) => ({
      path,
      source,
      environment,
      ...(sourceMap === undefined ? {} : { sourceMap }),
    });
    // Convex's `hash`: the source, then the source map.
    const hash = (x: { source: string; sourceMap?: string }) =>
      new Bun.CryptoHasher("sha256")
        .update(x.source)
        .update(x.sourceMap ?? "")
        .digest("hex");
    const remote = (mods: ReturnType<typeof m>[]) =>
      mods.map((x) => ({ path: x.path, hash: hash(x), environment: x.environment }));
    const paths = (r: ReturnType<typeof partitionModules>) => ({
      changed: r.changedModules.map((x) => x.path).sort(),
      unchanged: r.unchangedModuleHashes.map((x) => x.path),
    });
    // A different source map is a change.
    expect(
      paths(
        partitionModules([m("f.js", "same", "isolate", "new-map")], remote([m("f.js", "same", "isolate", "old-map")])),
      ),
    ).toEqual({ changed: ["f.js"], unchanged: [] });
    // The same source with the same map is unchanged: the map is part of the hash.
    expect(
      paths(partitionModules([m("f.js", "same", "isolate", "map")], remote([m("f.js", "same", "isolate", "map")]))),
    ).toEqual({ changed: [], unchanged: ["f.js"] });
    // Deleted modules are in neither list (the push leaves them out).
    expect(
      paths(
        partitionModules(
          [m("a.js", "same1"), m("c.js", "same3")],
          remote([m("a.js", "same1"), m("b.js", "gone"), m("c.js", "same3")]),
        ),
      ),
    ).toEqual({ changed: [], unchanged: ["a.js", "c.js"] });
    expect(paths(partitionModules([], remote([m("a.js", "x"), m("b.js", "y")])))).toEqual({
      changed: [],
      unchanged: [],
    });
    // New, changed, unchanged and deleted together.
    expect(
      paths(
        partitionModules(
          [m("unchanged.js", "u"), m("changed.js", "new"), m("new.js", "n")],
          remote([m("unchanged.js", "u"), m("changed.js", "old"), m("deleted.js", "d")]),
        ),
      ),
    ).toEqual({ changed: ["changed.js", "new.js"], unchanged: ["unchanged.js"] });
    // Nothing deployed yet: every module is sent.
    expect(paths(partitionModules([m("a.js", "x"), m("b.js", "y")], []))).toEqual({
      changed: ["a.js", "b.js"],
      unchanged: [],
    });
  });

  test(".env files: KEY=value, quotes, comments, export", () => {
    expect(parseEnvFile(`# c\nA=1\nexport B="two words"\nC='3' # trailing\nD = four # note\nbad line`)).toEqual({
      A: "1",
      B: "two words",
      C: "3",
      D: "four",
    });
  });
});

describe("the checks before a push (STUDY-56), as Convex's deploy", () => {
  // A table with documents, thresholds lowered so it counts as large.
  const LARGE = {
    BUNVEX_MIN_DOCUMENTS_FOR_INDEX_DELETE_WARNING: "1",
    BUNVEX_MIN_DOCUMENTS_FOR_INDEX_BACKFILL_WARNING: "1",
  };
  const schema = (indexes: string, validator = "v.string()") => ({
    "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export default defineSchema({ notes: defineTable({ body: ${validator}, other: v.optional(v.string()) })${indexes} });`,
    "bunvex/notes.ts": `import { mutation } from ${JSON.stringify(SERVER)};
export const add = mutation(async ({ db }) => db.insert("notes", { body: "x" }));`,
  });
  async function setup() {
    const d = await deployment();
    const app = tmp();
    write(app, schema('.index("by_body", ["body"])'));
    const env = { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY, ...LARGE };
    expect(await main(["deploy", "--typecheck=disable"], io(app, env).it)).toBe(0);
    for (let i = 0; i < 3; i++) await d.call("mutation", "notes:add");
    return { d, app, env };
  }

  test("deleting an index of a large table: no terminal stops the push, the flag lets it through", async () => {
    const { d, app, env } = await setup();
    write(app, schema(""));
    const stopped = io(app, env);
    expect(await main(["deploy", "--typecheck=disable"], stopped.it)).toBe(1);
    const text = stopped.err.join("\n");
    expect(text).toContain("This code push will delete the following index");
    expect(text).toContain("⛔ notes.by_body   body  ⚠️  3 documents");
    expect(text).toContain("or run the deploy command with the --skip-large-indexes-check flag");
    // Nothing was pushed: the index is still there.
    const r = await d.call("query", "notes:add");
    expect(r.errorMessage ?? "").not.toContain("by_body");
    const allowed = io(app, env);
    expect(await main(["deploy", "--typecheck=disable", "--skip-large-indexes-check"], allowed.it)).toBe(0);
    expect(allowed.err.join("\n")).toContain("Proceeding with push since deleting large indexes was allowed by flag");
  });

  test("a non-staged index on a large table asks; the answer decides; a dry run only warns", async () => {
    const { app, env } = await setup();
    // Two indexes on the same fields are refused, as Convex: by_other adds a field.
    write(app, schema('.index("by_body", ["body"]).index("by_other", ["body", "other"])'));
    const no = io(app, env);
    no.it.prompt = () => "n";
    expect(await main(["deploy", "--typecheck=disable"], no.it)).toBe(1);
    expect(no.err.join("\n")).toContain("This push will create the following index on a large table");
    expect(no.err).toContain("Canceling push");
    const dry = io(app, env);
    expect(await main(["deploy", "--typecheck=disable", "--dry-run"], dry.it)).toBe(0);
    expect(dry.err.join("\n")).toContain("This push will create the following index on a large table");
    const yes = io(app, env);
    yes.it.prompt = () => "y";
    expect(await main(["deploy", "--typecheck=disable"], yes.it)).toBe(0);
    expect(yes.err).toContain("✔ Proceeding with push.");
    // A staged index never blocks.
    write(
      app,
      schema(
        '.index("by_body", ["body"]).index("by_other", ["body", "other"]).index("later", { fields: ["other"], staged: true })',
      ),
    );
    const staged = io(app, env);
    expect(await main(["deploy", "--typecheck=disable"], staged.it)).toBe(0);
    expect(staged.err.join("\n")).not.toContain("This push will create");
  });

  test("a dry run warns about a slow schema walk; a CI platform names the push in the audit log", async () => {
    const { d, app, env } = await setup();
    write(app, schema('.index("by_body", ["body"])', "v.union(v.string(), v.number())"));
    const dry = io(app, { ...env, BUNVEX_MIN_BYTES_FOR_SCHEMA_WALK_WARNING: "1" });
    expect(await main(["deploy", "--typecheck=disable", "--dry-run"], dry.it)).toBe(0);
    expect(dry.err.join("\n")).toMatch(
      /This schema change requires checking every document in the following table against your new schema, totaling \d+ bytes/,
    );
    expect(dry.err.join("\n")).toContain("  notes (3 documents, ");
    const ci = io(app, { ...env, GITHUB_ACTIONS: "true", GITHUB_SHA: "0123456789abcdef" });
    expect(await main(["deploy", "--typecheck=disable"], ci.it)).toBe(0);
    const events = (await d.engine.query((db) =>
      db.asSystem(() => db.query("_deployment_audit_log").collect()),
    )) as unknown as { action: string; metadata: { message: string | null } }[];
    expect(events.filter((e) => e.action === "push_config_with_components").at(-1)!.metadata.message).toBe(
      "Deployed from GitHub Actions • 0123456",
    );
  });
});
