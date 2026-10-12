// The dashboard's server source (@bunvex/dashboard-source, STUDY-149 PR 1) against a live bunvex server in this
// process: the dashboard's contract suite for the areas built so far (the deployment and its counters, the
// logs, the deployment state), then what the contract does not pin down — the sign-in's verifier, the schema,
// the function metrics, the live log tail and the methods not built yet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunvexClient } from "@bunvex/client";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import { type DataSourceError, type LogEntry, OPERATIONS } from "@bunvex/dashboard/data-source";
import {
  createAdminKeyVerifier,
  createServerDataSource,
  INVALID_CREDENTIALS,
  type ServerDataSource,
} from "@bunvex/dashboard-source";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";

const INSTANCE = "dashboard-source";
const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const cipherKey = adminKeyCipherKey(SECRET);
const ADMIN_KEY = issueAdminKey({ instanceName: INSTANCE, cipherKey });
const READ_ONLY_KEY = issueAdminKey({ instanceName: INSTANCE, cipherKey, readOnly: true });

let url = "";
let stop = () => {};
const sources: ServerDataSource[] = [];
const open = (adminKey = ADMIN_KEY) => {
  const s = createServerDataSource({ url, adminKey, logs: { firstAnswerMs: 500 } });
  sources.push(s);
  return s;
};

/** Runs a public function over the HTTP API, as an app would. */
async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function until<T>(
  f: () => T | undefined | false | Promise<T | undefined | false>,
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

/** What `bunvex deploy` does, over deploy2 (STUDY-35): start the push, wait for the schema, finish. */
async function deploy(modules: { path: string; source: string }[]) {
  const post = async (path: string, body: object) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: ADMIN_KEY, ...body }),
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
}

beforeAll(async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: INSTANCE,
    instanceSecret: SECRET,
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
  url = `http://127.0.0.1:${server.server.port}`;
  stop = () => server.shutdown();
  await deploy([
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ messages: defineTable({ body: v.string() }) });`,
    },
    {
      path: "messages.js",
      source: `import { mutation, query } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const list = query(async ({ db }) => {
          console.log("listing messages");
          return (await db.query("messages").collect()).map((m) => m.body);
        });
        export const send = mutation({ args: { body: v.string() }, handler: async ({ db }, { body }) => {
          console.warn(\`sending \${body}\`);
          await db.insert("messages", { body });
        } });`,
    },
  ]);
  // some history for the log tests: lines at two levels, from a query and a mutation
  for (let i = 0; i < 3; i++) await call("mutation", "messages:send", { body: `m${i}` });
  for (let i = 0; i < 3; i++) await call("query", "messages:list");
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  stop();
});

// The areas whose server side exists today; the others follow with STUDY-149 PRs 2–5.
describeDataSourceContract("@bunvex/dashboard-source on a live server", () => open(), {
  only: ["deployment", "logs", "state"],
  pause: { toggle: true },
});

describe("sign-in (Convex's checkDeploymentInfo)", () => {
  test("a full key: every operation, not read-only", async () => {
    expect(await createAdminKeyVerifier().verify(url, ADMIN_KEY)).toEqual({
      ok: true,
      allowedOps: [],
      isReadOnly: false,
    });
  });

  test("a read-only key: its operations, read-only; the source's capabilities follow", async () => {
    const check = await createAdminKeyVerifier().verify(`${url}/`, READ_ONLY_KEY);
    if (!check.ok) throw new Error(check.error);
    expect(check.isReadOnly).toBe(true);
    expect(check.allowedOps).toContain("ViewData");
    expect(check.allowedOps).not.toContain("WriteData");
    const caps = await open(READ_ONLY_KEY).getCapabilities();
    expect(caps.readOnly).toBe(true);
    expect(caps.operations).toContain("viewData");
    expect(caps.operations).not.toContain("writeData");
    expect((await open().getCapabilities()).operations).toEqual([...OPERATIONS]);
  });

  test("a wrong key is refused after Convex's 3 tries", async () => {
    let asked = 0;
    const counting = ((input: RequestInfo | URL, init?: RequestInit) => {
      asked++;
      return fetch(input, init);
    }) as typeof fetch;
    const other = issueAdminKey({ instanceName: INSTANCE, cipherKey: adminKeyCipherKey("00".repeat(32)) });
    const check = await createAdminKeyVerifier({ fetch: counting, retryDelayMs: 1 }).verify(url, other);
    expect(check).toEqual({ ok: false, error: INVALID_CREDENTIALS });
    expect(asked).toBe(3);
  });

  test("a server without check_admin_key (404) allows every operation", async () => {
    const bare = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status: 404 }) });
    try {
      expect(await createAdminKeyVerifier().verify(`http://127.0.0.1:${bare.port}`, ADMIN_KEY)).toEqual({
        ok: true,
        allowedOps: [],
        isReadOnly: false,
      });
    } finally {
      bare.stop(true);
    }
  });
});

describe("the deployment", () => {
  test("name, version and persistence come from the server", async () => {
    const d = await open().getDeployment();
    expect(d.name).toBe(INSTANCE);
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.persistence).toBe("memory");
    expect(d.url).toBe(url);
  });

  test("the schema: declared tables with their document types, enforced, no validation running", async () => {
    const schema = await open().getSchema();
    expect(schema.enforced).toBe(true);
    expect(schema.validation).toBeUndefined();
    expect(schema.tables).toEqual([
      {
        name: "messages",
        validator: { type: "object", value: { body: { fieldType: { type: "string" }, optional: false } } },
      },
    ]);
  });

  test("the counters: /stats under the contract's names, with the live subscriptions", async () => {
    const app = new BunvexClient(url, { logger: false });
    const off = app.onUpdate("messages:list", {}, () => {});
    try {
      const src = open();
      const s = await until(async () => {
        const got = await src.getStats();
        return got.subscriptions >= 1 && got;
      }, "the app's subscription");
      expect(s.commitTs).toBeGreaterThan(0);
      expect(s.subscriptionReruns).toBeGreaterThanOrEqual(1);
    } finally {
      off();
      await app.close();
    }
  });

  test("watchStats samples on its interval and stops on unsubscribe", async () => {
    const src = createServerDataSource({ url, adminKey: ADMIN_KEY, statsIntervalMs: 10 });
    sources.push(src);
    let calls = 0;
    const off = src.watchStats(
      () => calls++,
      () => {},
    );
    await until(() => calls >= 3, "three samples");
    off();
    const stopped = calls;
    await Bun.sleep(60);
    expect(calls).toBe(stopped);
  });

  test("the deployment state is read over the socket", async () => {
    expect(await open().getDeploymentState?.()).toEqual({ state: "running" });
  });
});

describe("logs", () => {
  test("history: each line with its function, and an outcome line per execution", async () => {
    const { page } = await open().listLogs({ numItems: 100, cursor: null });
    const warn = page.find((e) => e.level === "warn");
    expect(warn?.message).toMatch(/^sending m\d$/);
    expect(warn?.function).toEqual({ path: "messages:send", kind: "mutation" });
    const outcome = page.find((e) => e.execution && e.function?.path === "messages:list");
    expect(outcome?.execution?.status).toBe("success");
    expect(outcome?.execution?.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome?.executionId).toBeTruthy();
    expect(outcome?.requestId).toBeTruthy();
  });

  test("a new execution reaches watchLogs within one long poll, filtered; the history does not", async () => {
    const src = open();
    const seen: LogEntry[] = [];
    let failure: DataSourceError | null = null;
    const off = src.watchLogs(
      { function: "messages:send" },
      (e) => seen.push(...e),
      (e) => {
        failure = e;
      },
    );
    // the first answer is the history: listed, not delivered
    await src.listLogs({ numItems: 1, cursor: null });
    expect(seen).toEqual([]);
    await call("query", "messages:list");
    await call("mutation", "messages:send", { body: "live" });
    await until(() => seen.some((e) => e.execution), "the mutation's outcome line");
    off();
    expect(failure).toBeNull();
    expect(seen.every((e) => e.function?.path === "messages:send")).toBe(true);
    expect(seen.some((e) => e.message === "sending live")).toBe(true);
  });
});

describe("function metrics (Convex's /api/app_metrics)", () => {
  const window = () => {
    const end = Date.now() + 60_000;
    return { start: end - 10 * 60_000, end, numBuckets: 10 };
  };

  test("udf_rate's per-second rate becomes a count per bucket", async () => {
    const src = open();
    const w = window();
    const before = (await src.functionRate?.("messages:send", "invocations", w)) ?? [];
    await call("mutation", "messages:send", { body: "counted" });
    const after = (await src.functionRate?.("messages:send", "invocations", w)) ?? [];
    const total = (s: { value: number | null }[]) => s.reduce((n, b) => n + (b.value ?? 0), 0);
    expect(after).toHaveLength(10);
    expect(Math.round(total(after) - total(before))).toBe(1);
  });

  test("latency percentiles in milliseconds, in the order asked", async () => {
    const got = (await open().latencyPercentiles?.("messages:list", [99, 50], window())) ?? [];
    expect(got.map((p) => p.percentile)).toEqual([99, 50]);
    const values = got.flatMap((p) => p.series.flatMap((b) => (b.value === null ? [] : [b.value])));
    expect(values.length).toBeGreaterThan(0);
    // the server's floor is 1 ms, sent as 0.001 s
    expect(values.every((x) => x >= 1)).toBe(true);
  });

  test("top functions are named by their display path", async () => {
    const top = (await open().topFunctions?.("invocations", window(), 5)) ?? [];
    expect(top.map((t) => t.function).sort()).toEqual(["messages:list", "messages:send"]);
  });
});

describe("what is not built yet (STUDY-149 PRs 2 and 4)", () => {
  test("the tables, documents and functions answer unavailable; watchTable reports it asynchronously", async () => {
    const src = open();
    for (const p of [src.listTables(), src.listDocuments({ table: "messages", numItems: 1, cursor: null })]) {
      const e = await p.then(
        () => null,
        (err: DataSourceError) => err,
      );
      expect(e?.code).toBe("unavailable");
    }
    const e = await src.listFunctions().then(
      () => null,
      (err: DataSourceError) => err,
    );
    expect(e?.code).toBe("unavailable");
    let error: DataSourceError | null = null;
    src.watchTable(
      "messages",
      () => {},
      (err) => {
        error = err;
      },
    );
    expect(error).toBeNull();
    await until(() => error, "watchTable's error");
    expect((error as DataSourceError | null)?.code).toBe("unavailable");
  });
});
