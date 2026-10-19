// `bunvex deploy` with components (STUDY-156 PR 1): the app's `bunvex.config.ts` and the definitions it imports,
// local and from a package, found through Bun's metafile, bundled with their children's imports as
// `./_componentDeps/<base64url(path)>`, and pushed with each component's functions; an app without one pushes a
// `defineApp()` of its own (DV-429); Convex's lines for an installed or unmounted component.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { bundleComponents } from "../src/components.ts";
import { type Io, main } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "ce".repeat(32);
const NAME = "component-push-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-components-"));
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
  const post = async (path: string, body: object) =>
    (await (
      await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>;
  const run = (componentPath: string, path: string, args: object = {}) =>
    post("/api/function", { componentPath, path, args, format: "json" });
  return { url, post, run, engine };
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env: {}, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { it, out, err };
}

// The app's imports, spelled so the dependency checker does not take them for this test's own.
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));

/** A component named `name` with a `messages` table and `lib:add` / `lib:count`. */
const component = (name: string, extra = ""): Record<string, string> => ({
  "bunvex.config.ts": `import { defineComponent } from ${SERVER};\nconst c = defineComponent(${JSON.stringify(name)});\n${extra}export default c;\n`,
  "schema.ts": `import { defineSchema, defineTable } from ${SERVER};\nimport { v } from ${VALUES};\nexport default defineSchema({ messages: defineTable({ body: v.string() }) });\n`,
  "lib.ts": `import { mutation, query } from ${SERVER};\nimport { v } from ${VALUES};\nexport const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => { await ctx.db.insert("messages", a); } });\nexport const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("messages").collect()).length });\n`,
});
const under = (prefix: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([p, t]) => [`${prefix}/${p}`, t]));

/** An app mounting a local `counter` (which mounts the package's `limiter` itself) and the package's `limiter`. */
function app(mounts = "app.use(counter);\napp.use(limiter);\n") {
  const root = tmp();
  write(root, {
    "bunvex/bunvex.config.ts": `import { defineApp } from ${SERVER};\nimport counter from "../components/counter/bunvex.config";\nimport limiter from "@acme/limiter/bunvex.config.js";\nconst app = defineApp();\n${mounts}export default app;\n`,
    "bunvex/app.ts": `import { query } from ${SERVER};\nexport const hi = query({ args: {}, handler: async () => "hi" });\n`,
    ...under(
      "components/counter",
      component("counter", `import limiter from "@acme/limiter/bunvex.config.js";\nc.use(limiter);\n`),
    ),
    // A package as published: its config under the `bunvex` condition's path, built JS elsewhere.
    "node_modules/@acme/limiter/package.json": JSON.stringify({
      name: "@acme/limiter",
      type: "module",
      exports: {
        "./bunvex.config.js": { bunvex: "./dist/component/bunvex.config.ts", default: "./missing.js" },
      },
    }),
    ...under("node_modules/@acme/limiter/dist/component", component("limiter")),
  });
  return root;
}

const deploy = (root: string, url: string) =>
  main(["deploy", "--url", url, "--admin-key", KEY, "--typecheck=disable", "--codegen=disable"], io(root).it);

describe("bundling", () => {
  test("the graph, its paths, and each definition's children as `_componentDeps` imports", async () => {
    const root = app();
    const b = await bundleComponents(join(root, "bunvex"), root);
    const paths = b.components.map((c) => c.definitionPath);
    expect(paths).toEqual(["../components/counter", "../node_modules/@acme/limiter/dist/component"]);
    expect(b.app.dependencies).toEqual(paths);
    const dep = (p: string) => `./_componentDeps/${Buffer.from(p).toString("base64url")}`;
    expect(b.app.definition.path).toBe("bunvex.config.js");
    expect(b.app.definition.source).toContain(dep("../components/counter"));
    expect(b.app.definition.source).toContain(dep("../node_modules/@acme/limiter/dist/component"));
    expect(b.components[0]!.dependencies).toEqual(["../node_modules/@acme/limiter/dist/component"]);
    expect(b.components[0]!.functions.map((m) => m.path)).toEqual(["lib.js"]);
    expect(b.components[0]!.schema?.path).toBe("schema.js");
  });

  test("an app without a definition pushes `defineApp()`", async () => {
    const root = tmp();
    write(root, { "bunvex/app.ts": "export const x = 1;\n" });
    const b = await bundleComponents(join(root, "bunvex"), root);
    expect(b.components).toEqual([]);
    expect(b.app.definition.source).toContain("defineApp()");
  });

  test("a component's \"use node\" module is refused, as Convex's", async () => {
    const root = app();
    write(root, { "components/counter/act.ts": `"use node";\nexport const x = 1;\n` });
    await expect(bundleComponents(join(root, "bunvex"), root)).rejects.toThrow(
      '"use node" directive is not supported in components. Remove it from the component at: ',
    );
  });
});

describe("bunvex deploy", () => {
  test("installs the components; their functions run in their own namespaces", async () => {
    const d = await deployment();
    const root = app();
    const r = io(root);
    expect(
      await main(["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=disable", "--codegen=disable"], r.it),
    ).toBe(0);
    expect(r.err).toContain("Installed component counter.");
    expect(r.err).toContain("Installed component limiter.");
    expect(r.err).toContain("Installed component counter/limiter.");
    expect((await d.run("counter", "lib:add", { body: "x" })).status).toBe("success");
    expect(await d.run("counter", "lib:count")).toMatchObject({ value: 1 });
    expect(await d.run("counter/limiter", "lib:count")).toMatchObject({ value: 0 });
    expect(await d.run("", "app:hi")).toMatchObject({ value: "hi" });
  });

  test("an unmount prints its line; a push that changes nothing prints none", async () => {
    const d = await deployment();
    const root = app();
    expect(await deploy(root, d.url)).toBe(0);
    const again = io(root);
    expect(
      await main(["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=disable", "--codegen=disable"], again.it),
    ).toBe(0);
    expect(again.err.filter((l) => l.includes("component"))).toEqual([]);
    write(root, {
      "bunvex/bunvex.config.ts": `import { defineApp } from ${SERVER};\nimport counter from "../components/counter/bunvex.config";\nconst app = defineApp();\napp.use(counter);\nexport default app;\n`,
    });
    const unmount = io(root);
    expect(
      await main(
        ["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=disable", "--codegen=disable"],
        unmount.it,
      ),
    ).toBe(0);
    expect(unmount.err).toContain("Unmounted component limiter.");
  });

  test("a component's schema that its documents fail names the component", async () => {
    const d = await deployment();
    const root = app();
    expect(await deploy(root, d.url)).toBe(0);
    await d.run("counter", "lib:add", { body: "x" });
    write(root, {
      "components/counter/schema.ts": `import { defineSchema, defineTable } from ${SERVER};\nimport { v } from ${VALUES};\nexport default defineSchema({ messages: defineTable({ body: v.number() }) });\n`,
    });
    const failed = io(root);
    expect(
      await main(["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=disable", "--codegen=disable"], failed.it),
    ).toBe(1);
    expect(failed.err.join("\n")).toContain('✖ Schema validation failed in component "counter".');
  });

  test("an app without a definition stores the one it pushes (DV-429)", async () => {
    const d = await deployment();
    const root = tmp();
    write(root, {
      "bunvex/app.ts": `import { query } from ${SERVER};\nexport const hi = query({ args: {}, handler: async () => "hi" });\n`,
    });
    expect(await deploy(root, d.url)).toBe(0);
    const modules = (await d.engine.query((db) =>
      db.asSystem(() => db.inComponent(null, () => db.query("_modules").collect())),
    )) as unknown as { path: string }[];
    expect(modules.map((m) => m.path)).toContain("bunvex.config.js");
  });
});
