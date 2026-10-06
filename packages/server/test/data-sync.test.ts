// Data sync (STUDY-69), Convex's `/api/v1/data/sync`: Convex's sealed protobuf cursor, a snapshot walked by
// id (each value its revision's ts) and then the log, truncates as tables enter the sync, the status, the
// limits (a commit never split), catching up along the log while a table is walked, `Convex-Client`, the
// progress rows with `create_data_sync`, the other routes, and the errors.
import { afterEach, describe, expect, test } from "bun:test";
import { compareInternalIds, DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { toJsonValue, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import {
  DATA_SYNC_LIMITS,
  type DataSyncCursor,
  dataSyncPage,
  decodeCursor,
  encodeCursor,
  openCursor,
  sealCursor,
} from "../src/data-sync.ts";
import { Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "c1".repeat(32);
const NAME = "data-sync-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 8 });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()), b: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    put: mutation(({ db }, { table, n, doc }: { table: string; n: number; doc?: object }) =>
      Promise.all(Array.from({ length: n }, () => db.insert(table, (doc ?? {}) as never))),
    ),
    patch: mutation(({ db }, { id, doc }: { id: string; doc: object }) => db.patch(id as never, doc as never)),
    del: mutation(({ db }, { id }: { id: string }) => db.delete(id as never)),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const call = async (path: string, args: object) =>
    (
      (await (
        await fetch(`${api}/mutation`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args: toJsonValue(args as never) }),
        })
      ).json()) as { value: any }
    ).value;
  const req = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bunvex ${KEY}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, text, body: text ? JSON.parse(text) : null };
  };
  const sync = (body: object = {}, headers?: Record<string, string>) => req("v1/data/sync", body, headers);
  return { engine, call, req, sync };
}

/** Pages until up to date, from `cursor`; every page's body. */
async function untilUpToDate(t: Awaited<ReturnType<typeof setup>>, cursor?: string, extra: object = {}) {
  const pages: any[] = [];
  let next = cursor;
  for (let i = 0; i < 50; i++) {
    const r = await t.sync({ ...(next === undefined ? {} : { cursor: next }), ...extra });
    expect(r.status).toBe(200);
    pages.push(r.body);
    next = r.body.pagination.nextCursor;
    if (r.body.status.type === "upToDate") break;
  }
  return { pages, cursor: next! };
}

describe("the cursor", () => {
  test("Convex's protobuf round-trips; sealed in hex; a tampered one is InvalidDataSyncCursor", async () => {
    const t = await setup();
    const [id] = await t.call("m:put", { table: "a", n: 1 });
    const c: DataSyncCursor = {
      syncedTs: 1_700_000_000_000_123_456n,
      synced: [{ tablet: "AAAAAAAAAAAAAAAAAAAABw", component: "", table: "x" }],
      current: { tablet: "AAAAAAAAAAAAAAAAAAAACQ", component: "", table: "a", currentId: id, docsSynced: 3 },
      syncId: "fivetran-abc",
      numDocsSynced: 42,
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    const done = { ...c, current: null };
    expect(decodeCursor(encodeCursor(done))).toEqual(done);
    const hex = sealCursor(t.engine, c);
    expect(hex).toMatch(/^01[0-9a-f]+$/);
    expect(openCursor(t.engine, hex)).toEqual(c);
    const tampered = hex.slice(0, -2) + (hex.endsWith("00") ? "01" : "00");
    expect(() => openCursor(t.engine, tampered)).toThrow("Could not parse the data sync cursor");
    expect((await t.sync({ cursor: "zz" })).body).toEqual({
      code: "InvalidDataSyncCursor",
      message: "Could not parse the data sync cursor",
    });
  });
});

test("a cold start: truncate, then each table by id (revision ts), then up to date; then the log", async () => {
  const t = await setup();
  const [a1] = await t.call("m:put", { table: "a", n: 2, doc: { k: 1n } });
  await t.call("m:put", { table: "b", n: 1 });
  const { pages, cursor } = await untilUpToDate(t, undefined);
  expect(pages[0].status).toEqual({ type: "snapshotting" });
  expect(pages[0].syncId).toMatch(/^[0-9a-f-]{36}$/);
  // `a` enters, and `b` too once `a` is walked on the same page (Convex: a table's truncate comes as it
  // enters the sync).
  expect(pages[0].truncates).toEqual([
    { component: "", table: "a" },
    { component: "", table: "b" },
  ]);
  // Tables walked in tablet order (their `_tables` rows' internal ids, as Convex's), which is random.
  const aFirst = compareInternalIds(t.engine.catalog.table("a").id, t.engine.catalog.table("b").id) < 0;
  const all = pages.flatMap((p) => p.values);
  const fromA: [string, boolean][] = [
    ["a", false],
    ["a", false],
  ];
  const fromB: [string, boolean][] = [["b", false]];
  expect(all.map((x: any) => [x.table, x.deleted])).toEqual(aFirst ? [...fromA, ...fromB] : [...fromB, ...fromA]);
  const values = [...all.filter((x: any) => x.table === "a"), ...all.filter((x: any) => x.table === "b")];
  // export_json values; `ts` the revision's (nanoseconds).
  expect(values[0].value.k).toBe(1);
  const aTs = values[0].ts;
  expect(values[1].ts).toBe(aTs);
  expect(values[2].ts).toBeGreaterThan(aTs);
  expect(pages.at(-1).status.type).toBe("upToDate");
  // Changes: an insert, a patch, a delete — from the log, in order, a tombstone with `_id` only.
  await t.call("m:put", { table: "b", n: 1, doc: { k: 2n } });
  await t.call("m:patch", { id: a1, doc: { k: 3n } });
  await t.call("m:del", { id: a1 });
  const after = await untilUpToDate(t, cursor);
  const changes = after.pages.flatMap((p) => p.values);
  expect(changes.map((x: any) => [x.table, x.deleted, x.value])).toMatchObject([
    ["b", false, { k: 2 }],
    ["a", false, { k: 3 }],
    ["a", true, { _id: a1 }],
  ]);
  expect(after.pages.flatMap((p) => p.truncates)).toEqual([]);
  expect(after.pages[0].syncId).toBe(pages[0].syncId);
});

test("selection: a table added later is truncated and snapshotted; one removed emits nothing", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1 });
  await t.call("m:put", { table: "b", n: 2 });
  const onlyA = { selection: { _other: "excluded", "": { _other: "excluded", a: { _other: "included" } } } };
  const first = await untilUpToDate(t, undefined, onlyA);
  expect(first.pages.flatMap((p) => p.values).map((x: any) => x.table)).toEqual(["a"]);
  const both = await untilUpToDate(t, first.cursor);
  expect(both.pages.flatMap((p) => p.truncates)).toEqual([{ component: "", table: "b" }]);
  expect(both.pages.flatMap((p) => p.values).map((x: any) => x.table)).toEqual(["b", "b"]);
  const back = await t.sync({ cursor: both.cursor, ...onlyA });
  expect(back.body.truncates).toEqual([]);
  expect(back.body.status.type).toBe("upToDate");
  // Selected again: forgotten when it was left out, so it is truncated and walked again.
  const again = await untilUpToDate(t, back.body.pagination.nextCursor);
  expect(again.pages.flatMap((p) => p.truncates)).toEqual([{ component: "", table: "b" }]);
  expect(again.pages.flatMap((p) => p.values).map((x: any) => x.table)).toEqual(["b", "b"]);
});

test("limits: by-id pages of `pageSize`; a log page never splits a commit; catching up while a table is walked", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 5 });
  const all = { _other: "included" } as const;
  const small = { ...DATA_SYNC_LIMITS, pageSize: 2, maxRowsRead: 2 };
  const ids = () => crypto.randomUUID();
  let page = await dataSyncPage(t.engine, null, all, ids, small);
  // Tables are walked in tablet order (random): an empty `b` first takes a page of its own.
  if (compareInternalIds(t.engine.catalog.table("b").id, t.engine.catalog.table("a").id) < 0) {
    expect(page.values.length).toBe(0);
    page = await dataSyncPage(t.engine, page.cursor, all, ids, small);
  }
  expect(page.values.length).toBe(2);
  const first = page.values.map((x) => JSON.parse(x.json)._id as string);
  expect(page.cursor.current?.docsSynced).toBe(2);
  // Behind the freshness bound (0 here): a log page instead. A new document of the table being walked is
  // past its position, so the walk will read it; one before it is captured from the log.
  await t.call("m:put", { table: "a", n: 3 });
  // A document the walk already passed changes: only the log can carry it (Convex's "captured").
  await t.call("m:del", { id: first[0] });
  const walkedAt = page.cursor.syncedTs;
  page = await dataSyncPage(t.engine, page.cursor, all, ids, { ...small, byIdFreshnessNs: 0n });
  // A log page: the sync's timestamp moved on.
  expect(page.cursor.syncedTs).toBeGreaterThan(walkedAt);
  let tombstones = page.values.filter((x) => x.deleted).map((x) => JSON.parse(x.json)._id);
  expect(page.status).toEqual({ type: "snapshotting" });
  // The 3-row commit is taken whole although the page holds 2.
  expect(page.values.length).toBeLessThanOrEqual(3);
  for (const x of page.values) expect(x.table).toBe("a");
  // Walking on: every document exactly once from the walk or the log, and the sync completes.
  let c = page.cursor;
  const seen = new Set<string>([...first, ...page.values.map((x) => JSON.parse(x.json)._id as string)]);
  let status = page.status.type;
  for (let i = 0; i < 40 && status !== "upToDate"; i++) {
    const p = await dataSyncPage(t.engine, c, all, ids, small);
    for (const x of p.values) seen.add(JSON.parse(x.json)._id);
    tombstones = [...tombstones, ...p.values.filter((x) => x.deleted).map((x) => JSON.parse(x.json)._id)];
    c = p.cursor;
    status = p.status.type;
  }
  expect([c.current, status]).toEqual([null, "upToDate"]);
  expect(seen.size).toBe(8);
  expect(tombstones).toEqual([first[0]]);
});

test("Bunvex-Client: the sync id's prefix; a malformed header is a 400", async () => {
  const t = await setup();
  const r = await t.sync({}, { "bunvex-client": "fivetran-export-1.2.3" });
  expect(r.body.syncId).toMatch(/^fivetran-[0-9a-f-]{36}$/);
  expect((await t.sync({}, { "bunvex-client": "airbyte-export-0.1.0" })).body.syncId).toMatch(/^airbyte-/);
  expect((await t.sync({}, { "bunvex-client": "x" })).body.code).toBe("InvalidClientVersion");
});

test("progress: a row with create_data_sync; get_sync and list_active_syncs; their errors", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1 });
  const { pages } = await untilUpToDate(t);
  const syncId = pages[0].syncId;
  const one = await t.req(`v1/data/sync/${syncId}`);
  // Both tables are targets (`b` is empty).
  expect(one.body).toMatchObject({ syncId, status: { type: "upToDate", totalTables: 2, numDocumentsSynced: 1 } });
  expect(typeof one.body.lastUpdated).toBe("number");
  const audit = (await t.engine.query((db) =>
    db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect()),
  )) as any[];
  expect(audit.filter((e) => e.action === "create_data_sync").map((e) => e.metadata)).toEqual([{ sync_id: syncId }]);
  const list = await t.req("v1/data/list_active_syncs");
  expect(list.body).toMatchObject({ syncs: [{ syncId }], pagination: { hasMore: false } });
  expect((await t.req("v1/data/list_active_syncs?limit=0")).body).toEqual({
    code: "LimitOutOfRange",
    message: "The limit for listing active syncs must be between 1 and 100",
  });
  expect((await t.req("v1/data/sync/nope")).body).toEqual({
    code: "DataSyncNotFound",
    message: "No active data sync with id nope. A data sync is active for 3 days after its most recent page.",
  });
});

test("data_sync_cursor_from_deltas: continue a document_deltas sync from its cursor", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1 });
  // A document_deltas cursor: list_snapshot's snapshot (a connector's state after its snapshot phase).
  const snap = await t.req("list_snapshot");
  const at = /"snapshot":(\d+)/.exec(snap.text)![1]!;
  await t.call("m:put", { table: "a", n: 1, doc: { k: 9n } });
  const conv = await t.req("data_sync_cursor_from_deltas", `{"cursor":${at}}`, {
    "bunvex-client": "fivetran-export-1.0.0",
  });
  expect(conv.status).toBe(200);
  const page = await t.sync({ cursor: conv.body.cursor });
  expect(page.body.truncates).toEqual([]);
  expect(page.body.values.map((x: any) => x.value.k)).toEqual([9]);
  expect(page.body.syncId).toMatch(/^fivetran-/);
  expect((await t.req("data_sync_cursor_from_deltas", `{"cursor":-1}`)).body.code).toBe("InvalidDataSyncCursor");
  const ahead = (BigInt(Date.now() + 10_000_000) * 1_000_000n).toString();
  expect((await t.req("data_sync_cursor_from_deltas", `{"cursor":${ahead}}`)).body).toEqual({
    code: "InvalidDataSyncCursor",
    message: "document_deltas cursor is ahead of the deployment's latest timestamp",
  });
});

test("a cursor behind the retention window is DataSyncCursorExpired", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1 });
  const { cursor } = await untilUpToDate(t);
  await t.call("m:put", { table: "a", n: 1 });
  const real = t.engine.retention;
  (t.engine as { retention: unknown }).retention = { minDocumentTs: t.engine.committer.visibleTs + 1n };
  const r = await t.sync({ cursor });
  (t.engine as { retention: unknown }).retention = real;
  expect(r.body.code).toBe("DataSyncCursorExpired");
});
