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
    expect(r.err).toContain("  [+] index messages.by_author");
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
    expect(paths.sort()).toEqual(["crons.js", "files.js", "http.js", "jobs.js", "lib/format.js", "messages.js"]);
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
    expect(failed.err.join("\n")).toContain(`bunvex/a.ts(3,`);
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
    expect(await main(["deploy", "--codegen=sometimes", ...flags], io(app).it)).toBe(2);
  }, 120_000);

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
    expect(none.err[0]).toMatch(/no deployment: set BUNVEX_SELF_HOSTED_URL/);
    write(app, {
      "bunvex/a.ts": `import { query } from ${JSON.stringify(SERVER)}; throw new Error("broken"); export const q = query(async () => 1);`,
    });
    const broken = io(app, { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY });
    expect(await main(["deploy"], broken.it)).toBe(1);
    expect(broken.err[0]).toContain("Failed to analyze a.js: Uncaught Error: broken");
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

  test(".env files: KEY=value, quotes, comments, export", () => {
    expect(parseEnvFile(`# c\nA=1\nexport B="two words"\nC='3' # trailing\nD = four # note\nbad line`)).toEqual({
      A: "1",
      B: "two words",
      C: "3",
      D: "four",
    });
  });
});
