// The Data screen's writes (STUDY-149 PR 3), where Convex's local backend is not needed to tell (the oracle is
// packages/differential/test/dashboard-writes.test.ts): bunvex's undefined placeholder (DV-478), a failed write
// leaving nothing behind (no document, no event), a clear's page bounded by the bytes it reads, and the operation
// a key needs.
import { afterEach, describe, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { UNDEFINED_PLACEHOLDER } from "../src/data-system-functions.ts";
import { MAX_CLEAR_ROWS } from "../src/data-system-mutations.ts";
import { Functions } from "../src/functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const schema = defineSchema({ strict: defineTable({ name: v.string() }), free: defineTable(v.any()) });
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  stops.push(() => engine.close());
  const functions = new Functions(engine);
  const sys = (name: string, args: Record<string, unknown> = {}) =>
    functions.runSystemMutation(`_system/frontend/${name}`, args) as Promise<unknown>;
  const all = (table: string) => engine.query((db) => db.query(table).collect()) as Promise<Record<string, unknown>[]>;
  const events = () =>
    engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect())) as unknown as Promise<
      { action: string; metadata: Record<string, unknown> }[]
    >;
  return { engine, sys, all, events };
}

describe("the Data screen's mutations", () => {
  test("a patch removes a field given bunvex's placeholder; Convex's is an ordinary string here", async () => {
    const { sys, all } = await setup();
    await sys("addDocument", { table: "free", documents: [{ a: 1, b: 2 }] });
    const [doc] = await all("free");
    await sys("patchDocumentsFields", { table: "free", ids: [doc!._id], fields: { a: UNDEFINED_PLACEHOLDER } });
    const convexWord = UNDEFINED_PLACEHOLDER.replace("BUNVEX", "CONVEX");
    await sys("patchDocumentsFields", { table: "free", ids: [doc!._id], fields: { b: convexWord } });
    const [after] = await all("free");
    expect("a" in after!).toBe(false);
    expect(after!.b).toBe(convexWord);
  });

  test("a refused insert writes nothing and records nothing, the earlier documents of the call included", async () => {
    const { sys, all, events } = await setup();
    const e = await sys("addDocument", { table: "strict", documents: [{ name: "ok" }, { name: 1 }] }).catch(
      (x: Error) => x,
    );
    expect((e as Error).name).toBe("BunvexError");
    expect((e as unknown as { data: string }).data).toMatch(/^Failed to insert or update a document in table "strict"/);
    expect(await all("strict")).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test("the events carry the root component, the table and the ids, in the write's transaction", async () => {
    const { sys, all, events } = await setup();
    expect(await sys("addDocument", { table: "free", documents: [{ k: 1 }, { k: 2 }], componentId: null })).toEqual({
      success: true,
    });
    const ids = (await all("free")).map((d) => d._id);
    expect((await sys("createTable", { table: "made" })) ?? null).toBeNull(); // null on the wire
    await sys("deleteDocuments", { toDelete: ids.map((id) => ({ id, tableName: "free" })) });
    expect((await events()).map((e) => [e.action, e.metadata])).toEqual([
      ["add_documents", { component_id: null, component: null, table: "free", document_ids: ids }],
      ["create_table", { component_id: null, component: null, table: "made" }],
      ["delete_documents", { component_id: null, component: null, table: "free", document_ids: ids }],
    ]);
  });

  test("a clear's page stops at 3 MB read: big documents take more pages than 4 000 would", async () => {
    const { sys, all } = await setup();
    const big = "x".repeat(400_000);
    await sys("addDocument", { table: "free", documents: Array.from({ length: 12 }, (_, i) => ({ i, big })) });
    const first = (await sys("clearTablePage", { tableName: "free", cursor: null })) as {
      deleted: number;
      hasMore: boolean;
      continueCursor: string;
    };
    expect(first.hasMore).toBe(true);
    expect(first.deleted).toBeLessThan(12);
    expect(first.deleted).toBeGreaterThan(0);
    // the oldest went first
    expect((await all("free")).map((d) => d.i)).toEqual(
      Array.from({ length: 12 - first.deleted }, (_, i) => i + first.deleted),
    );
    let cursor: string | null = first.continueCursor;
    for (let n = 0; cursor !== null && n < 12; n++) {
      const p = (await sys("clearTablePage", { tableName: "free", cursor })) as {
        hasMore: boolean;
        continueCursor: string;
      };
      cursor = p.hasMore ? p.continueCursor : null;
    }
    expect(await all("free")).toEqual([]);
    expect(MAX_CLEAR_ROWS).toBe(4000);
  });
});
