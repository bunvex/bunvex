// A bunvex server in the test's process for the dashboard source's tests (STUDY-149): an in-memory engine with a
// stored schema, an admin key, and an app pushed over deploy2 as `bunvex deploy` does (STUDY-35).
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";

export type LiveServer = {
  url: string;
  adminKey: string;
  readOnlyKey: string;
  /** Runs a public function over the HTTP API, as an app would; its value. */
  call(kind: "query" | "mutation" | "action", path: string, args?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
};

/** Starts the server and pushes `modules` (the first one is the schema). */
export async function startLiveServer(
  instanceName: string,
  modules: { path: string; source: string }[],
): Promise<LiveServer> {
  const secret = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
  const cipherKey = adminKeyCipherKey(secret);
  const adminKey = issueAdminKey({ instanceName, cipherKey });
  const readOnlyKey = issueAdminKey({ instanceName, cipherKey, readOnly: true });
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName,
    instanceSecret: secret,
    storedSchema: true,
  }).init();
  const server = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    sitePort: null,
    label: "memory",
    deployable: true,
  });
  const url = `http://127.0.0.1:${server.server.port}`;

  const post = async (path: string, body: object) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey, ...body }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status !== 200) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const [schema, ...rest] = modules.map((m) => ({ ...m, environment: "isolate" }));
  const start = await post("/api/deploy2/start_push", {
    dryRun: false,
    functions: "bunvex",
    appDefinition: {
      definition: null,
      dependencies: [],
      schema,
      changedModules: rest,
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: [],
    nodeDependencies: [],
  });
  let wait: Record<string, unknown>;
  do wait = await post("/api/deploy2/wait_for_schema", { schemaChange: start.schemaChange, timeoutMs: 1000 });
  while (wait.type === "inProgress");
  await post("/api/deploy2/finish_push", { startPush: start, dryRun: false });

  return {
    url,
    adminKey,
    readOnlyKey,
    async call(kind, path, args = {}) {
      const res = await fetch(`${url}/api/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      });
      const body = (await res.json()) as { status: string; value?: unknown; errorMessage?: string };
      if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
      return body.value;
    },
    stop: () => server.shutdown(),
  };
}

/** Polls `f` every 10 ms until it is truthy; fails after `ms`. */
export async function until<T>(
  f: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  what: string,
  ms = 5000,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const x = await f();
    if (x) return x;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
