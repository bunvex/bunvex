// The dashboard's server source (@bunvex/dashboard-source, STUDY-149 PRs 1–2) against a live bunvex server in
// this process: the dashboard's contract suite for the areas built so far (the deployment and its counters, the
// tables and documents, the logs, the deployment state), then what the contract does not pin down — the
// sign-in's verifier, the schema, the function metrics, the live log tail, the Data screen's reads and live
// tables, and the methods not built yet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunvexClient } from "@bunvex/client";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import {
  type DataSourceError,
  type Document,
  type FieldFilter,
  type FilterExpression,
  type LogEntry,
  OPERATIONS,
  type Page,
} from "@bunvex/dashboard/data-source";
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

/** The `items` documents (a table of any documents, with an index on `kind, n`). */
const ITEMS: Record<string, unknown>[] = [
  { kind: "a", n: 1, label: "one" },
  { kind: "a", n: 2, label: "two" },
  { kind: "b", n: 3, label: "three" },
  { kind: "b", n: 4 },
  { kind: "c", n: 5, label: "five", big: { $integer: "BQAAAAAAAAA=" } },
  { kind: "a", n: 6, label: "six", raw: { $bytes: "AQID" } },
  { kind: "c", n: 7, label: "seven" },
  { kind: "b", n: 8, label: "eight", tags: ["x"] },
  { n: 9, label: "nine" },
  { kind: "a", n: 10, label: "ten", meta: { edited: true } },
];

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

/** The app's schema; `extra` adds tables (a later push). */
const schemaModule = (extra = "") => ({
  path: "schema.js",
  source: `import { defineSchema, defineTable } from "@bunvex/server";
    import { v } from "@bunvex/values";
    export default defineSchema({
      messages: defineTable({ body: v.string() }),
      items: defineTable(v.any()).index("by_kind", ["kind", "n"]),
      empty: defineTable({ x: v.number() }),${extra}
    });`,
});
/** The app's functions. */
const APP_MODULES = [
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
  {
    path: "items.js",
    source: `import { mutation } from "@bunvex/server";
      import { v } from "@bunvex/values";
      export const add = mutation({ args: { doc: v.any() }, handler: ({ db }, { doc }) => db.insert("items", doc) });
      export const patch = mutation({ args: { id: v.id("items"), fields: v.any() }, handler: ({ db }, { id, fields }) =>
        db.patch(id, fields) });`,
  },
];

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
  await deploy([schemaModule(), ...APP_MODULES]);
  // the contract's table (the one with the most documents): mixed kinds, a missing field, int64 and bytes
  for (const doc of ITEMS) await call("mutation", "items:add", { doc });
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
  only: ["deployment", "tables", "documents", "logs", "state"],
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
        name: "empty",
        validator: { type: "object", value: { x: { fieldType: { type: "number" }, optional: false } } },
      },
      { name: "items" },
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
    expect(top.map((t) => t.function).sort()).toEqual(["items:add", "messages:list", "messages:send"]);
  });
});

describe("what is not built yet (STUDY-149 PR 4)", () => {
  test("the functions answer unavailable", async () => {
    const e = await open()
      .listFunctions()
      .then(
        () => null,
        (err: DataSourceError) => err,
      );
    expect(e?.code).toBe("unavailable");
  });
});

describe("the Data screen (STUDY-149 PR 2)", () => {
  const items = async (src: ServerDataSource, filter?: FilterExpression) => {
    const out: Document[] = [];
    let cursor: string | null = null;
    for (;;) {
      const p: Page<Document> = await src.listDocuments({ table: "items", numItems: 4, cursor, filter });
      out.push(...p.page);
      if (p.isDone) return out;
      cursor = p.continueCursor;
    }
  };
  const one = (c: Omit<FieldFilter, "id" | "enabled">, order: "asc" | "desc" = "asc"): FilterExpression => ({
    clauses: [{ id: "c", enabled: true, ...c }],
    order,
  });

  test("tables: the mapping's user tables with their sizes, indexes and whether the schema declares them", async () => {
    const tables = await open().listTables();
    expect(tables.map((t) => [t.name, t.declared])).toEqual([
      ["empty", true],
      ["items", true],
      ["messages", true],
    ]);
    const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
    expect(byName.empty?.documentCount).toBe(0);
    expect(byName.items?.documentCount).toBeGreaterThanOrEqual(ITEMS.length);
    expect(byName.items?.indexes).toEqual([
      { name: "by_id", fields: ["_id"], system: true, state: "ready" },
      { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" },
      { name: "by_kind", fields: ["kind", "n"], system: false, state: "ready" },
    ]);
  });

  test("documents: int64 and bytes come in their JSON encodings, and filter by type", async () => {
    const src = open();
    const docs = await items(src);
    expect(docs.find((d) => d.label === "five")?.big).toEqual({ $integer: "BQAAAAAAAAA=" });
    expect(docs.find((d) => d.label === "six")?.raw).toEqual({ $bytes: "AQID" });
    const ints = await items(src, one({ field: "big", op: "type", value: "int64" }));
    expect(ints.map((d) => d.label)).toEqual(["five"]);
  });

  test("an unset field is below every value: it passes lt, not gte (Convex's order, DV-479)", async () => {
    const src = open();
    const lt = await items(src, one({ field: "kind", op: "lt", value: "b" }));
    expect(lt.map((d) => d.n)).toEqual([1, 2, 6, 9, 10]);
    const gte = await items(src, one({ field: "kind", op: "gte", value: "a" }));
    expect(gte.some((d) => d.n === 9)).toBe(false);
  });

  test("anyOf of nothing filters nothing (Convex's, DV-479)", async () => {
    const src = open();
    const all = await items(src);
    expect((await items(src, one({ field: "kind", op: "anyOf", value: [] }))).length).toBe(all.length);
  });

  test("a type clause reads the top-level field by its name, not a dotted path (Convex's, DV-479)", async () => {
    const got = await items(open(), one({ field: "meta.edited", op: "type", value: "unset" }));
    expect(got.some((d) => d.label === "ten")).toBe(true);
  });

  test("a value the server refuses names its clause", async () => {
    const e = await open()
      .listDocuments({
        table: "items",
        numItems: 5,
        cursor: null,
        filter: {
          clauses: [
            { id: "x", field: "n", op: "lt", value: 5, enabled: true },
            { id: "y", field: "n", op: "gt", value: 0, enabled: false },
            { id: "bad", field: "label", op: "eq", value: { $nope: 1 }, enabled: true },
          ],
          order: "asc",
        },
      })
      .catch((err: DataSourceError) => err);
    expect([(e as DataSourceError).code, (e as DataSourceError).details.clause]).toEqual(["invalid_request", "bad"]);
  });

  test("watchTable: a write to a loaded page or the size is reported, with the count; nothing after the stop", async () => {
    const src = open();
    const counts: (number | undefined)[] = [];
    let failure: DataSourceError | null = null;
    // the grid's first page (newest first, 2 documents) and the oldest document, opened by id
    const firstPage = await src.listDocuments({ table: "items", numItems: 2, cursor: null });
    const all = await items(open()); // another source: this one has loaded the first page only
    const oldest = all.at(-1)!;
    const middle = all[4]!;
    const off = src.watchTable(
      "items",
      (c) => counts.push(c.count),
      (e) => {
        failure = e;
      },
    );
    // a document neither loaded nor opened: not reported (Convex's grid sees only its pages and the size)
    await call("mutation", "items:patch", { id: middle._id, fields: { touched: 1 } });
    await Bun.sleep(150);
    expect(counts).toEqual([]);
    // a loaded document changes: reported, the count unchanged
    await call("mutation", "items:patch", { id: firstPage.page[0]!._id, fields: { touched: 2 } });
    await until(() => counts.length >= 1, "the patch of a loaded document");
    const size = (await src.listTables()).find((t) => t.name === "items")!.documentCount!;
    expect(counts[0]).toBe(size);
    // the open document changes
    await src.getDocument("items", oldest._id);
    await Bun.sleep(50);
    const before = counts.length;
    await call("mutation", "items:patch", { id: oldest._id, fields: { touched: 3 } });
    await until(() => counts.length > before, "the patch of the open document");
    // an insert: the size grows
    await call("mutation", "items:add", { doc: { kind: "z", n: 99 } });
    await until(() => counts.includes(size + 1), "the insert's count");
    off();
    const stopped = counts.length;
    await call("mutation", "items:add", { doc: { kind: "z", n: 100 } });
    await Bun.sleep(150);
    expect(counts.length).toBe(stopped);
    expect(failure).toBeNull();
  });

  test("watchTable with no page loaded: the size alone; its stop ends its subscriptions", async () => {
    const src = open();
    const subscriptions = async () => (await src.getStats()).subscriptions;
    await src.listTables(); // the source's own subscriptions (the table mapping) first
    const before = await subscriptions();
    const counts: (number | undefined)[] = [];
    const off = src.watchTable(
      "items",
      (c) => counts.push(c.count),
      () => {},
    );
    await until(async () => (await subscriptions()) > before, "the size's subscription");
    const size = (await src.listTables()).find((t) => t.name === "items")!.documentCount!;
    await call("mutation", "items:add", { doc: { kind: "y", n: 50 } });
    await until(() => counts.includes(size + 1), "the insert's count");
    off();
    await until(async () => (await subscriptions()) === before, "the subscriptions' end");
  });

  test("tableRate: rows written per bucket; an unknown table is not_found", async () => {
    const src = open();
    const end = Date.now() + 60_000;
    const w = { start: end - 10 * 60_000, end, numBuckets: 10 };
    const total = (s: { value: number | null }[]) => s.reduce((n, b) => n + (b.value ?? 0), 0);
    const before = total((await src.tableRate?.("items", "rowsWritten", w)) ?? []);
    await call("mutation", "items:add", { doc: { kind: "rate", n: 0 } });
    const after = (await src.tableRate?.("items", "rowsWritten", w)) ?? [];
    expect(after).toHaveLength(10);
    expect(Math.round(total(after) - before)).toBe(1);
    const e = await src.tableRate?.("nope", "rowsRead", w).catch((err: DataSourceError) => err);
    expect((e as DataSourceError).code).toBe("not_found");
  });

  test("inferDocumentType: the shape as a document type; null for an empty table; one fetch per 2 s", async () => {
    let fetched = 0;
    const counting = ((input: string, init?: RequestInit) => {
      if (input.includes("/api/shapes2")) fetched++;
      return fetch(input, init);
    }) as typeof fetch;
    const src = createServerDataSource({ url, adminKey: ADMIN_KEY, fetch: counting });
    sources.push(src);
    const [type, empty] = await Promise.all([src.inferDocumentType?.("items"), src.inferDocumentType?.("empty")]);
    expect(empty).toBeNull();
    expect(type?.type).toBe("object");
    const fields = (type as { value: Record<string, { fieldType: { type: string }; optional: boolean }> }).value;
    expect(fields.n).toEqual({ fieldType: { type: "number" }, optional: false });
    expect(fields.kind?.optional).toBe(true);
    expect(fields.big).toEqual({ fieldType: { type: "bigint" }, optional: true });
    expect(fields.raw).toEqual({ fieldType: { type: "bytes" }, optional: true });
    expect(Object.keys(fields).some((k) => k.startsWith("_"))).toBe(false);
    expect(fetched).toBe(1);
    await Bun.sleep(2100);
    await src.inferDocumentType?.("items");
    expect(fetched).toBe(2);
  });

  test("tableOfId: a user table's id names it; a system table's does not", async () => {
    const src = open();
    const [doc] = (await src.listDocuments({ table: "items", numItems: 1, cursor: null })).page;
    expect(await src.tableOfId?.(doc!._id)).toBe("items");
    expect(await src.tableOfId?.("not an id")).toBeNull();
  });

  test("the table list is live: a table a later push creates is listed", async () => {
    const src = open();
    expect((await src.listTables()).map((t) => t.name)).not.toContain("later");
    await deploy([schemaModule("\n      later: defineTable(v.any()),"), ...APP_MODULES]);
    // the mapping the source keeps subscribed gets the new table; no refetch of it is asked
    await until(async () => (await src.listTables()).some((t) => t.name === "later"), "the new table");
  });
});
