// A pending schema's validation persisted as Convex's (STUDY-127): `_schema_validations` attempts and their
// `_schema_validation_progress` counters, flushed as the walk goes, removed when the schema resolves, and
// started over after a restart.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { schemaValidationProgress } from "../src/schema-validations.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-validations-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const open = async (path: string) => {
  const e = await new Engine(defineSchema({}), new SqlitePersistence(path, { durable: true }), {
    storedSchema: true,
    indexBackfill: { chunkRate: null },
  }).init();
  engines.push(e);
  return e;
};
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 2000; i++) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out");
};
type Row = Record<string, unknown> & { _id: string };
const rows = (e: Engine, table: string) =>
  e.query((db) => db.asSystem(() => db.query(table).collect())) as unknown as Promise<Row[]>;
const schemaState = async (e: Engine, id: string) => (await rows(e, SCHEMAS_TABLE)).find((r) => r._id === id)?.state;
const loose = defineSchema({ items: defineTable(v.any()) });
const strict = defineSchema({ items: defineTable({ n: v.number() }) });

/** An engine whose active schema accepts anything, with `n` documents in `items`. */
async function withItems(path: string, n: number, bad = false) {
  const e = await open(path);
  const p0 = await e.startSchemaPush(loose);
  await until(async () => (await e.schemaPushStatus(p0.schemaId)).type === "complete");
  await e.commitSchemaPush(p0.schemaId, async () => {});
  await e.mutation(async (db) => {
    for (let i = 0; i < n; i++) await db.insert("items", { n: bad && i === n - 1 ? "bad" : i });
  });
  await e.summariesReady();
  return e;
}

describe("schema validation attempts and progress, as Convex's (STUDY-127)", () => {
  test("each walked table has an attempt and its counters; valid once walked; Convex's numbers", async () => {
    const e = await withItems(tmp(), 600);
    expect(e.catalog.table("_schema_validations").number).toBe(555);
    expect(e.catalog.table("_schema_validation_progress").number).toBe(549);
    const p = await e.startSchemaPush(strict);
    await until(async () => (await schemaState(e, p.schemaId)) === "validated");
    const [attempt, ...more] = await rows(e, "_schema_validations");
    expect(more).toEqual([]);
    expect(attempt).toMatchObject({ schemaId: p.schemaId, tableName: "items", state: { state: "valid" } });
    expect(await rows(e, "_schema_validation_progress")).toEqual([
      expect.objectContaining({ validationId: attempt!._id, numDocsValidated: 600n, totalDocs: 600n }),
    ]);
    // Active: its attempts are gone (Convex's `mark_active`).
    await e.commitSchemaPush(p.schemaId, async () => {});
    expect(await rows(e, "_schema_validations")).toEqual([]);
    expect(await rows(e, "_schema_validation_progress")).toEqual([]);
  });

  test("progress is flushed as the walk goes, every 5 % of the table; the dashboard's sum reads it", async () => {
    const e = await withItems(tmp(), 4000);
    const p = await e.startSchemaPush(strict);
    const seen = new Set<number>();
    await until(async () => {
      const r = await e.query((db) => schemaValidationProgress(db, p.schemaId));
      if (r) {
        expect(r.totalDocs).toBe(4000);
        seen.add(r.numDocsValidated);
      }
      return (await schemaState(e, p.schemaId)) === "validated";
    });
    const between = [...seen].filter((n) => n > 0 && n < 4000);
    expect(between.length).toBeGreaterThan(0);
    for (const n of between) expect(n % 200).toBe(0);
    // Not pending any more: nothing to report.
    expect(await e.query((db) => schemaValidationProgress(db, null))).toBeNull();
  });

  test("a failed or overwritten schema loses its attempts", async () => {
    const e = await withItems(tmp(), 50, true);
    const failed = await e.startSchemaPush(strict);
    await until(async () => (await schemaState(e, failed.schemaId)) === "failed");
    expect(await rows(e, "_schema_validations")).toEqual([]);
    expect(await rows(e, "_schema_validation_progress")).toEqual([]);
    // An overwritten one: its attempt goes with it, the newer push's stays.
    const f = await withItems(tmp(), 50);
    const older = await f.startSchemaPush(strict);
    await until(async () => (await rows(f, "_schema_validations")).length === 1);
    const newer = await f.startSchemaPush(defineSchema({ items: defineTable({ n: v.float64() }) }));
    expect(await schemaState(f, older.schemaId)).toBe("overwritten");
    await until(async () => (await schemaState(f, newer.schemaId)) === "validated");
    expect((await rows(f, "_schema_validations")).map((r) => r.schemaId)).toEqual([newer.schemaId]);
    expect(await rows(f, "_schema_validation_progress")).toHaveLength(1);
  });

  test("after a restart a pending schema is walked again from the start, with new attempts", async () => {
    const path = tmp();
    const a = await withItems(path, 3000);
    const p = await a.startSchemaPush(strict);
    await a.close();
    engines.splice(engines.indexOf(a), 1);
    const b = await open(path);
    expect(await schemaState(b, p.schemaId)).not.toBe("failed");
    await until(async () => (await schemaState(b, p.schemaId)) === "validated");
    const attempts = await rows(b, "_schema_validations");
    expect(attempts.map((r) => [r.schemaId, r.tableName, r.state])).toEqual([
      [p.schemaId, "items", { state: "valid" }],
    ]);
    expect((await rows(b, "_schema_validation_progress"))[0]).toMatchObject({
      validationId: attempts[0]!._id,
      numDocsValidated: 3000n,
    });
    // Writes are checked against it again: one that does not match fails it.
    await b.mutation((db) => db.insert("items", { n: "late" }));
    await until(async () => (await schemaState(b, p.schemaId)) === "failed");
    expect(await rows(b, "_schema_validations")).toEqual([]);
  });
});
