// The deployment audit log (STUDY-48), as Convex's `_deployment_audit_log`: the events bunvex's changes
// record (in the change's transaction, with Convex's action names and metadata), the documents' shape, the
// dashboard's system queries, `GET /api/v1/list_audit_log_events` and the retention.
import { afterEach, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { type Value, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import { createServer, type ServerOptions } from "../src/server.ts";

const SECRET = "58".repeat(32);
const NAME = "audit-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 7 });
const SYSTEM = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), system: true });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup(opts: Partial<ServerOptions> = {}) {
  const engine = await new Engine(
    defineSchema({ keep: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    later: mutation(({ scheduler }) => scheduler.runAfter(3_600_000, "m:later" as never, {})),
    put: mutation(({ db }, { table }: { table: string }) => db.insert(table, {})),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    fileStorage: new MemoryBlobStore(),
    exportStorage: new MemoryBlobStore(),
    importStorage: new MemoryBlobStore(),
    ...opts,
  });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = (path: string, body: object | string = {}, key = KEY) =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: { authorization: `Bunvex ${key}`, "user-agent": "audit-test-agent", "x-forwarded-for": "10.1.2.3" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const call = async (kind: string, path: string, args: object = {}, key = KEY) =>
    (await (await post(`/api/${kind}`, { path, args }, key)).json()) as { status: string; value?: any };
  const events = () =>
    engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect())) as Promise<
      Record<string, Value>[]
    >;
  const list = async (query: string, key = KEY) => {
    const r = await fetch(`${api}/api/v1/list_audit_log_events?${query}`, {
      headers: { authorization: `Bunvex ${key}` },
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { engine, api, post, call, events, list };
}

test("environment variables: create, update, delete; Convex's document shape, actor and request", async () => {
  const t = await setup();
  const env = (changes: object[]) => t.post("/api/update_environment_variables", { changes });
  expect((await env([{ name: "A", value: "1" }])).status).toBe(200);
  expect((await env([{ name: "A", value: "2" }, { name: "B", value: "x" }, { name: "C" }])).status).toBe(200);
  expect((await env([{ name: "A" }])).status).toBe(200);
  const e = await t.events();
  expect(e.map((d) => [d.action, (d.metadata as { variable_name: string }).variable_name])).toEqual([
    ["create_environment_variable", "A"],
    ["update_environment_variable", "A"],
    ["create_environment_variable", "B"],
    ["delete_environment_variable", "A"],
  ]);
  const { _id, _creationTime, ...doc } = e[0]!;
  expect(Object.keys(doc)).toEqual([
    "action",
    "app_client_id",
    "client_ip",
    "client_user_agent",
    "member_id",
    "metadata",
    "token_id",
  ]);
  expect(doc).toEqual({
    action: "create_environment_variable",
    app_client_id: null,
    client_ip: "10.1.2.3",
    client_user_agent: "audit-test-agent",
    member_id: 7n,
    metadata: { variable_name: "A" },
    token_id: null,
  });
});

test("delete_tables, cancel_scheduled_function, cancel_all_scheduled_functions; the system key has no member", async () => {
  const t = await setup();
  await t.call("mutation", "m:put", { table: "keep" });
  await t.call("mutation", "m:put", { table: "gone" });
  expect((await t.post("/api/delete_tables", { tableNames: ["gone"], componentId: null })).status).toBe(200);
  const job = (await t.call("mutation", "m:later")).value as string;
  await t.call("mutation", "m:later");
  expect((await t.post("/api/cancel_job", { id: job }, SYSTEM)).status).toBe(200);
  expect((await t.post("/api/cancel_all_jobs", {})).status).toBe(200);
  // Nothing left to cancel: no event.
  expect((await t.post("/api/cancel_all_jobs", {})).status).toBe(200);
  const e = await t.events();
  expect(e.map((d) => [d.action, d.metadata, d.member_id])).toEqual([
    ["delete_tables", { component: null, component_id: null, table_names: ["gone"] }, 7n],
    [
      "cancel_scheduled_function",
      { component: null, component_id: null, function_path: "m.js:later", scheduled_function_id: job },
      null,
    ],
    ["cancel_all_scheduled_functions", { component: null, component_id: null }, 7n],
  ]);
});

test("exports: request_export, set_export_expiration, cancel_export", async () => {
  const t = await setup();
  expect((await t.post("/api/export/request/zip?includeStorage=true")).status).toBe(200);
  const [requested] = await t.events();
  const id = (requested!.metadata as { id: string }).id;
  expect(requested!.metadata).toEqual({
    component: null,
    component_id: null,
    format: "zip_with_storage",
    id,
    requestor: "snapshot_export",
  });
  await t.post(`/api/export/cancel/${id}`);
  const e = await t.events();
  expect(e.map((d) => d.action)).toContain("cancel_export");
  expect(e.find((d) => d.action === "cancel_export")!.metadata).toEqual({ id });
});

test("a snapshot import records snapshot_import in the transaction that finishes it", async () => {
  const t = await setup();
  const r = await t.post("/api/import?format=jsonLines&tableName=people&mode=requireEmpty", '{"a":1}\n{"a":2}\n');
  expect(r.status).toBe(200);
  const e = (await t.events()).filter((d) => d.action === "snapshot_import");
  expect(e).toHaveLength(1);
  expect(e[0]!.metadata).toEqual({
    import_format: { format: "jsonl", table: "people" },
    import_mode: "RequireEmpty",
    requestor: { type: "snapshotImport" },
    table_count: 1n,
    table_count_deleted: 0n,
    table_names: [{ component: null, table_names: ["people"] }],
    table_names_deleted: [{ component: null, table_names: [] }],
  });
  expect(e[0]!.member_id).toBeNull();
  // Keys in order, as a Convex object's; over HTTP, int64 as decimal strings (clean JSON).
  expect(Object.keys(e[0]!.metadata as object)).toEqual([
    "import_format",
    "import_mode",
    "requestor",
    "table_count",
    "table_count_deleted",
    "table_names",
    "table_names_deleted",
  ]);
  const listed = (await t.list("from=0")).body.items.find((i: any) => i.action === "snapshot_import");
  expect(listed.actor).toEqual({ kind: "system" });
  expect(listed.metadata.table_count).toBe("1");
  expect(listed.metadata.table_count_deleted).toBe("0");
});

test("file storage system mutations: generate_upload_url and delete_files", async () => {
  const t = await setup();
  const url = await t.call("mutation", "_system/frontend/fileStorageV2:generateUploadUrl", {});
  expect(url.status).toBe("success");
  const e = await t.events();
  expect(e.map((d) => [d.action, d.metadata])).toEqual([
    ["generate_upload_url", { component: null, component_id: null }],
  ]);
});

test("file URLs use the canonical cloud URL when one is set (STUDY-49)", async () => {
  const t = await setup();
  await t.post("/api/v1/update_canonical_url", { requestDestination: "bunvexCloud", url: "https://files.example.com" });
  const url = await t.call("mutation", "_system/frontend/fileStorageV2:generateUploadUrl", {});
  expect(url.value).toStartWith("https://files.example.com/api/storage/upload?token=");
});

test("the dashboard's queries: newest first with filters; from a time; the last push", async () => {
  const t = await setup();
  for (const name of ["A", "B", "C"])
    await t.post("/api/update_environment_variables", { changes: [{ name, value: "1" }] });
  await t.post("/api/update_environment_variables", { changes: [{ name: "A" }] });
  const page = await t.call("query", "_system/frontend/paginatedDeploymentEvents", {
    paginationOpts: { numItems: 10, cursor: null },
    filters: { minDate: 0, actions: ["create_environment_variable"], authorMemberIds: [{ $integer: "BwAAAAAAAAA=" }] },
  });
  expect(page.status).toBe("success");
  expect(page.value.page.map((d: any) => d.metadata.variable_name)).toEqual(["C", "B", "A"]);
  const none = await t.call("query", "_system/frontend/paginatedDeploymentEvents", {
    paginationOpts: { numItems: 10, cursor: null },
    filters: { minDate: 0, authorMemberIds: [{ $integer: "AQAAAAAAAAA=" }] },
  });
  expect(none.value.page).toEqual([]);
  const all = await t.call("query", "_system/frontend/listDeploymentEventsFromTime", { fromTimestamp: 0 });
  expect(all.value.map((d: any) => d.action)).toEqual([
    "create_environment_variable",
    "create_environment_variable",
    "create_environment_variable",
    "delete_environment_variable",
  ]);
  expect((await t.call("query", "_system/frontend/deploymentEvents:lastPushEvent")).value).toBeNull();
});

test("GET /api/v1/list_audit_log_events: oldest first, pages, Convex's JSON and errors", async () => {
  const t = await setup();
  for (const name of ["A", "B", "C"])
    await t.post("/api/update_environment_variables", { changes: [{ name, value: "1" }] });
  const first = await t.list("from=0&limit=2");
  expect(first.status).toBe(200);
  expect(first.body.items.map((i: any) => i.metadata.variable_name)).toEqual(["A", "B"]);
  expect(first.body.items[0]).toEqual({
    actor: { kind: "member", member_id: 7 },
    action: "create_environment_variable",
    createTime: expect.any(Number),
    metadata: { variable_name: "A" },
    clientIp: "10.1.2.3",
    clientUserAgent: "audit-test-agent",
  });
  expect(first.body.pagination.hasMore).toBe(true);
  const next = await t.list(`from=0&limit=2&cursor=${first.body.pagination.nextCursor}`);
  expect(next.body.items.map((i: any) => i.metadata.variable_name)).toEqual(["C"]);
  expect(next.body.pagination).toEqual({ hasMore: false });
  expect((await t.list("from=0&limit=0")).body.code).toBe("LimitOutOfRange");
  expect((await t.list("from=0&limit=101")).body.code).toBe("LimitOutOfRange");
  expect((await t.list("limit=1")).body.code).toBe("BadQueryArgs");
});

test("retention: none refuses the HTTP list; a number refuses older reads and clamps the dashboard's", async () => {
  const off = await setup({ auditLogRetentionDays: null });
  const r = await off.list("from=0");
  expect(r.status).toBe(403);
  expect(r.body.code).toBe("AuditLogsDisabled");
  const week = await setup({ auditLogRetentionDays: 7 });
  expect((await week.list("from=0")).body.code).toBe("AuditLogsTooOld");
  expect((await week.list(`from=${Date.now() - 86_400_000}`)).status).toBe(200);
});
