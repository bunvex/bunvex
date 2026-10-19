// `bunvex deploy` with components (STUDY-156 PR 1): the app's `bunvex.config.ts` and the definitions it imports,
// local and from a package, found through Bun's metafile, bundled with their children's imports as
// `./_componentDeps/<base64url(path)>`, and pushed with each component's functions; an app without one pushes a
// `defineApp()` of its own (DV-429); Convex's lines for an installed or unmounted component.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { bundleComponents, findComponents } from "../src/components.ts";
import { type Io, main } from "../src/index.ts";
import { runCommand } from "../src/run.ts";
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
        "./bunvex.config.js": { bunvex: "./dist/component/bunvex.config.js", default: "./missing.js" },
      },
    }),
    // Published: its definition built to `.js`, so codegen leaves its `_generated/` alone.
    ...under(
      "node_modules/@acme/limiter/dist/component",
      Object.fromEntries(
        Object.entries(component("limiter")).map(([p, t]) => [p === "bunvex.config.ts" ? "bunvex.config.js" : p, t]),
      ),
    ),
  });
  return root;
}

/** A type import as the generated files write it (spelled so the dependency checker does not take it for one). */
const imp = (path: string) => `${"im"}port(${JSON.stringify(path)})`;
const bundled = async (root: string) => bundleComponents(await findComponents(join(root, "bunvex")), root);
const deploy = (root: string, url: string) =>
  main(["deploy", "--url", url, "--admin-key", KEY, "--typecheck=disable", "--codegen=disable"], io(root).it);

describe("bundling", () => {
  test("the graph, its paths, and each definition's children as `_componentDeps` imports", async () => {
    const root = app();
    const b = await bundled(root);
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
    const b = await bundled(root);
    expect(b.components).toEqual([]);
    expect(b.app.definition.source).toContain("defineApp()");
  });

  test("a component's \"use node\" module is refused, as Convex's", async () => {
    const root = app();
    write(root, { "components/counter/act.ts": `"use node";\nexport const x = 1;\n` });
    await expect(bundled(root)).rejects.toThrow(
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

describe("codegen", () => {
  /** The app on this repository's `bunvex`, with TypeScript, so its `_generated/` imports resolve and typecheck. */
  const typed = (root: string) => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../../bunvex"), join(root, "node_modules/bunvex"));
    symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(root, "node_modules/typescript"));
    write(root, { "package.json": JSON.stringify({ dependencies: { bunvex: "*" } }) });
  };
  const deployTyped = (root: string, url: string, r = io(root)) =>
    main(["deploy", "--url", url, "--admin-key", KEY, "--typecheck=enable"], r.it);

  test("`components` and each local component's `_generated/`, its `ComponentApi` from the validators", async () => {
    const d = await deployment();
    const root = app();
    expect(await main(["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=disable"], io(root).it)).toBe(0);
    const api = readFileSync(join(root, "bunvex/_generated/api.d.ts"), "utf8");
    expect(api).toContain(
      `export declare const components: {\n  counter: ${imp("../../components/counter/_generated/component.js")}.ComponentApi<"counter">;\n  limiter: ${imp("@acme/limiter/_generated/component.js")}.ComponentApi<"limiter">;\n};`,
    );
    expect(readFileSync(join(root, "bunvex/_generated/api.js"), "utf8")).toContain(
      "export const components = componentsGeneric();",
    );
    const component = readFileSync(join(root, "components/counter/_generated/component.ts"), "utf8");
    expect(component).toContain(
      'export type ComponentApi<Name extends string | undefined = string | undefined> = {\n  lib: {\n    add: FunctionReference<"mutation", "internal", { body: string }, any, Name>;\n    count: FunctionReference<"query", "internal", {}, any, Name>;\n  };\n};',
    );
    // The component's own `api`, its child the package's.
    expect(readFileSync(join(root, "components/counter/_generated/api.ts"), "utf8")).toContain(
      `limiter: ${imp("@acme/limiter/_generated/component.js")}.ComponentApi<"limiter">;`,
    );
    // A published component keeps its own `_generated/`.
    expect(() => readFileSync(join(root, "node_modules/@acme/limiter/dist/component/_generated/api.ts"))).toThrow();
  });

  test("a call into a component typechecks against its `ComponentApi`", async () => {
    const d = await deployment();
    const root = app("app.use(counter);\n");
    typed(root);
    // The counter alone: the package fixture has no types for TypeScript to resolve.
    write(root, {
      "bunvex/bunvex.config.ts": `import { defineApp } from ${SERVER};\nimport counter from "../components/counter/bunvex.config";\nconst app = defineApp();\napp.use(counter);\nexport default app;\n`,
      ...under("components/counter", { "bunvex.config.ts": component("counter")["bunvex.config.ts"]! }),
    });
    const call = (body: string) => ({
      "bunvex/use.ts": `import { mutation } from "./_generated/server";\nimport { components } from "./_generated/api";\nexport const go = mutation({ args: {}, handler: async (ctx): Promise<number> => { await ctx.runMutation(components.counter.lib.add, { body: ${body} }); return await ctx.runQuery(components.counter.lib.count, {}); } });\n// A reference into the component carries its path in its type.\nexport const path: "counter" = undefined as unknown as (typeof components.counter.lib.add)["_componentPath"];\n`,
    });
    write(root, call('"x"'));
    expect(await main(["codegen", "--init", "--typecheck=disable"], io(root).it)).toBe(0);
    // The first push writes the types; the second checks the code against them.
    expect(await main(["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=disable"], io(root).it)).toBe(0);
    const ok = io(root);
    if ((await deployTyped(root, d.url, ok)) !== 0) throw new Error([...ok.out, ...ok.err].join("\n"));
    write(root, call("1"));
    const bad = io(root);
    expect(await deployTyped(root, d.url, bad)).toBe(1);
    expect(Bun.stripANSI(bad.out.join("\n"))).toContain("bunvex/use.ts");
  }, 30_000);
});

describe("bunvex codegen", () => {
  test("without a deployment: the same `components` and `ComponentApi` a push writes (DV-532)", async () => {
    const root = app();
    const r = io(root);
    expect(await main(["codegen", "--typecheck=disable"], r.it)).toBe(0);
    expect(readFileSync(join(root, "bunvex/_generated/api.d.ts"), "utf8")).toContain(
      `limiter: ${imp("@acme/limiter/_generated/component.js")}.ComponentApi<"limiter">;`,
    );
    expect(readFileSync(join(root, "components/counter/_generated/component.ts"), "utf8")).toContain(
      'add: FunctionReference<"mutation", "internal", { body: string }, any, Name>;',
    );
  });

  test("a local component mounting a local one imports it from its own `_generated/` (DV-535)", async () => {
    const root = app("app.use(counter);\n");
    write(root, {
      "bunvex/bunvex.config.ts": `import { defineApp } from ${SERVER};\nimport counter from "../components/counter/bunvex.config";\nconst app = defineApp();\napp.use(counter);\nexport default app;\n`,
      ...under(
        "components/counter",
        component("counter", `import inner from "../inner/bunvex.config";\nc.use(inner);\n`),
      ),
      ...under("components/inner", component("inner")),
    });
    expect(await main(["codegen", "--typecheck=disable"], io(root).it)).toBe(0);
    expect(readFileSync(join(root, "components/counter/_generated/api.ts"), "utf8")).toContain(
      `inner: ${imp("../../inner/_generated/component.js")}.ComponentApi<"inner">;`,
    );
  });

  test("--component-dir: one component's `_generated/` alone; a directory without a definition is refused", async () => {
    const root = app();
    const r = io(root);
    const code = await main(["codegen", "--component-dir", "components/counter", "--typecheck=disable"], r.it);
    if (code !== 0) throw new Error(r.err.join("\n"));
    expect(readFileSync(join(root, "components/counter/_generated/component.ts"), "utf8")).toContain(
      'count: FunctionReference<"query", "internal", {}, any, Name>;',
    );
    expect(() => readFileSync(join(root, "bunvex/_generated/api.d.ts"))).toThrow();
    const refused = io(root);
    expect(await main(["codegen", "--component-dir", "components", "--typecheck=disable"], refused.it)).toBe(1);
    expect(refused.err[0]).toStartWith(
      "bunvex codegen: Only directories with bunvex.config.ts files are supported, this directory does not: ",
    );
  });

  test("--live-component-sources: a package resolves to its sources (DV-533)", async () => {
    const root = app("app.use(limiter);\n");
    write(root, {
      "node_modules/@acme/limiter/package.json": JSON.stringify({
        name: "@acme/limiter",
        type: "module",
        exports: {
          "./bunvex.config.js": {
            "@bunvex/component-source": "./src/component/bunvex.config.ts",
            bunvex: "./dist/component/bunvex.config.js",
          },
        },
      }),
      ...under("node_modules/@acme/limiter/src/component", component("sourced")),
    });
    expect(await main(["codegen", "--typecheck=disable"], io(root).it)).toBe(0);
    expect(readFileSync(join(root, "bunvex/_generated/api.d.ts"), "utf8")).toContain('ComponentApi<"limiter">');
    expect(await main(["codegen", "--live-component-sources", "--typecheck=disable"], io(root).it)).toBe(0);
    expect(readFileSync(join(root, "bunvex/_generated/api.d.ts"), "utf8")).toContain('ComponentApi<"sourced">');
    // From its sources, it is local: codegen writes its `_generated/`.
    expect(
      readFileSync(join(root, "node_modules/@acme/limiter/src/component/_generated/component.ts"), "utf8"),
    ).toContain("ComponentApi<");
  });
});

describe("bunvex run --component (DV-391)", () => {
  const run = (root: string, url: string, ...args: string[]) => {
    const r = io(root);
    return main(["run", "--url", url, "--admin-key", KEY, ...args], r.it).then((code) => ({ code, ...r }));
  };

  test("a component's function by its path; a missing one lists the component's functions", async () => {
    const d = await deployment();
    const root = app();
    expect(await deploy(root, d.url)).toBe(0);
    expect((await run(root, d.url, "--component", "counter", "lib:add", '{ body: "x" }')).code).toBe(0);
    expect((await run(root, d.url, "--component=counter", "lib:count")).out).toEqual(["1"]);
    expect((await run(root, d.url, "--component", "counter/limiter", "lib:count")).out).toEqual(["0"]);
    const missing = await run(root, d.url, "--component", "counter", "lib:nope");
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toContain("Available functions:\n• lib:add\n• lib:count");
  });

  test("--inline-query in a component; Convex's messages for an empty or unknown path", async () => {
    const d = await deployment();
    const root = app();
    expect(await deploy(root, d.url)).toBe(0);
    await run(root, d.url, "--component", "counter", "lib:add", '{ body: "x" }');
    const q = '(await ctx.db.query("messages").collect()).length';
    const inline = await run(root, d.url, "--component", "counter", "--inline-query", q);
    expect(inline.err).toEqual([]);
    expect(inline.out).toEqual(["1"]);
    expect((await run(root, d.url, "--component", " ", "--inline-query", q)).err).toEqual([
      "`--component` must not be empty.",
    ]);
    expect((await run(root, d.url, "--component", "nope", "--inline-query", q)).err).toEqual([
      'Component path "nope" was not found.\n\nAvailable components:\n• counter\n• counter/limiter\n• limiter\nOmit `--component` to target the app root.',
    ]);
  });

  test("--watch subscribes in the component", async () => {
    const d = await deployment();
    const root = app();
    expect(await deploy(root, d.url)).toBe(0);
    const r = io(root);
    const ctl = new AbortController();
    const done = runCommand(
      ["--url", d.url, "--admin-key", KEY, "--component", "counter", "--watch", "lib:count"],
      r.it,
      { signal: ctl.signal },
    );
    const until = async (pred: () => boolean) => {
      const end = Date.now() + 10_000;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out: ${r.err.join("\n")}`);
        await Bun.sleep(25);
      }
    };
    await until(() => r.out.includes("0"));
    await run(root, d.url, "--component", "counter", "lib:add", '{ body: "x" }');
    await until(() => r.out.includes("1"));
    ctl.abort();
    expect(await done).toBe(0);
  });

  test("--typecheck-components: a type error in a local component stops the push", async () => {
    const d = await deployment();
    const root = app("app.use(counter);\n");
    write(root, {
      "bunvex/bunvex.config.ts": `import { defineApp } from ${SERVER};\nimport counter from "../components/counter/bunvex.config";\nconst app = defineApp();\napp.use(counter);\nexport default app;\n`,
      "components/counter/bunvex.config.ts": component("counter")["bunvex.config.ts"]!,
      "components/counter/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
          skipLibCheck: true,
        },
      }),
      "components/counter/bad.ts": "export const n: number = 'not a number';\n",
    });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../../bunvex"), join(root, "node_modules/bunvex"));
    symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(root, "node_modules/typescript"));
    const flags = ["deploy", "--url", d.url, "--admin-key", KEY, "--typecheck=enable"];
    expect(await main(["codegen", "--init", "--typecheck=disable"], io(root).it)).toBe(0);
    expect(await main(flags, io(root).it)).toBe(0);
    const failed = io(root);
    expect(await main([...flags, "--typecheck-components"], failed.it)).toBe(1);
    expect(Bun.stripANSI(failed.out.join("\n"))).toContain("bad.ts");
  }, 30_000);
});
