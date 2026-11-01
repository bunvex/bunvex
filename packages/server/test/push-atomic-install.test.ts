// A push's code goes live at once, the app's and every component's (Convex's `finish_push` applies them in one
// transaction, `crates/application/src/deploy_config.rs`): a query run while a push installs sees all of the old code
// or all of the new, never the new app's with an old component's.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "ab".repeat(32);
const NAME = "push-atomic-install-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

const APP_DEFINITION = mod(
  "bunvex.config.js",
  `import { defineApp } from "@bunvex/server";\nimport counter from "${dep("counter")}";\nconst app = defineApp();\napp.use(counter);\napp.use(counter, { name: "second" });\nexport default app;`,
);

/** The app and its `counter` component, each answering which version it is. */
const versionOf = (v: string) => ({
  app: mod(
    "app.js",
    [
      'import { componentsGeneric, query } from "@bunvex/server";',
      "const components = componentsGeneric();",
      `export const which = query({ args: {}, handler: async (ctx) => [${JSON.stringify(v)}, await ctx.runQuery(components.counter.lib.which, {}), await ctx.runQuery(components.second.lib.which, {})] });`,
    ].join("\n"),
  ),
  counter: {
    definitionPath: "counter",
    definition: mod(
      "bunvex.config.js",
      `import { defineComponent } from "@bunvex/server";\nexport default defineComponent("counter");`,
    ),
    dependencies: [] as string[],
    schema: null,
    functions: [
      mod(
        "lib.js",
        `import { query } from "@bunvex/server";\nexport const which = query({ args: {}, handler: async () => ${JSON.stringify(v)} });`,
      ),
    ],
    udfServerVersion: "1.46.0",
  },
});

/** A module store slow to read, as a remote one: a push's install waits on it while queries run. */
class SlowStore extends MemoryBlobStore {
  override async get(...a: Parameters<MemoryBlobStore["get"]>) {
    await Bun.sleep(25);
    return super.get(...a);
  }
}

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-push-atomic-"));
  dirs.push(dir);
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
    moduleStorage: new SlowStore(),
    redactLogsToClient: false,
  });
  await s.codeReady;
  stops.push(async () => {
    s.server.stop(true);
    await engine.close();
  });
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const push = async (v: string) => {
    const code = versionOf(v);
    const start = await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition: APP_DEFINITION,
        dependencies: ["counter"],
        schema: null,
        changedModules: [code.app],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: [code.counter],
    });
    if (start.status !== 200) throw new Error(JSON.stringify(start.body));
    await post("/api/deploy2/wait_for_schema", {
      adminKey: KEY,
      schemaChange: start.body!.schemaChange,
      timeoutMs: 5000,
    });
    const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
    if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  };
  const which = async () => {
    const r = await post("/api/query", { path: "app:which", args: {}, format: "json" });
    if (r.body?.status !== "success") throw new Error(JSON.stringify(r.body));
    return (r.body.value as string[]).join("/");
  };
  return { push, which };
}

test("a query run while a push installs sees all of the old code or all of the new", async () => {
  const d = await deployment();
  await d.push("v1");
  expect(await d.which()).toBe("v1/v1/v1");
  for (let round = 2; round <= 4; round++) {
    const before = `v${round - 1}`;
    const after = `v${round}`;
    let done = false;
    const seen = new Set<string>();
    const pushed = d.push(after).finally(() => {
      done = true;
    });
    // Queries one after another on a few connections, for the whole push.
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (!done) seen.add(await d.which());
      }),
    );
    await pushed;
    seen.add(await d.which());
    const mixed = [...seen].filter(
      (s) => s !== [before, before, before].join("/") && s !== [after, after, after].join("/"),
    );
    expect(mixed).toEqual([]);
    expect(seen.has([after, after, after].join("/"))).toBe(true);
  }
});
