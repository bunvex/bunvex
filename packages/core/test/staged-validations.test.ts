// Staged validators' `_schema_validations` rows (STUDY-106 §7.1, §7.4; DV-438 PR 2), as Convex's 2ada334 and
// 7236c10: one row per staged table with its `validatorHash`, made by the push, carried over from the outgoing
// schemas when it can be reused, kept at activation, retried by a push of the same schema, restarted at a start;
// and the guardrail refusing a staged validator on a table whose enforced change needs a walk.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { SCHEMA_VALIDATION_PROGRESS_TABLE, SCHEMA_VALIDATIONS_TABLE } from "../src/catalog.ts";
import { Engine, StagedSchemaError } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";
import { schemaToJson, stagedValidatorsOf } from "../src/schema-json.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-staged-rows-"));
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
const push = async (e: Engine, s: SchemaDefinition) => {
  const p = await e.startSchemaPush(s);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
  expect((await e.schemaPushStatus(p.schemaId)).type).toBe("complete");
  await e.commitSchemaPush(p.schemaId, async () => {});
  return p.schemaId;
};
type Row = { _id: string; schemaId: string; tableName: string; validatorHash?: string; state: { state: string } };
type Progress = { validationId: string; numDocsValidated: bigint; totalDocs: bigint | null };
const rows = async (e: Engine) => {
  const [vs, ps] = (await e.query((db) =>
    db.asSystem(async () => [
      await db.query(SCHEMA_VALIDATIONS_TABLE).collect(),
      await db.query(SCHEMA_VALIDATION_PROGRESS_TABLE).collect(),
    ]),
  )) as unknown as [Row[], Progress[]];
  return vs.map((r) => {
    const p = ps.find((x) => x.validationId === r._id);
    return { ...r, numDocsValidated: p?.numDocsValidated, totalDocs: p?.totalDocs };
  });
};
/** Set a row's state and counters as a walk would have (the walk is DV-438 PR 4). */
const setRow = (e: Engine, id: string, state: Row["state"], done: bigint, total: bigint | null) =>
  e.mutation((db) =>
    db.asSystem(async () => {
      await db.patch(SCHEMA_VALIDATIONS_TABLE, id, { state });
      const p = (await db
        .query(SCHEMA_VALIDATION_PROGRESS_TABLE)
        .withIndex("by_validation_id", (q) => q.eq("validationId", id))
        .unique()) as unknown as { _id: string };
      await db.patch(SCHEMA_VALIDATION_PROGRESS_TABLE, p._id, { numDocsValidated: done, totalDocs: total });
    }),
  );

const enforced = { a: v.number() };
const withStaged = (staged: Record<string, ReturnType<typeof v.number>>) =>
  defineSchema({ t: defineTable(enforced).staged(staged as never) });

describe("validatorHash, as Convex's content_hash", () => {
  test("the sha256 of Convex's text, a float literal as serde writes it (hashes from Convex's binary)", () => {
    const s = defineSchema({
      t: defineTable({ a: v.number() }).staged({ a: v.union(v.number(), v.string()), b: v.optional(v.literal(1)) }),
      w: defineTable({ x: v.string() }).staged({ x: v.string() }),
    });
    const staged = stagedValidatorsOf(schemaToJson(s));
    expect(staged.get("t")!.hash).toBe("02fe0aeac91f874dbac7586ae50491149a097c0ab48c0228151f2b142ca51839");
    expect(staged.get("w")!.hash).toBe("84c916e64ef8915d1d08eb222818cb77806b9bd152ef7e1f208177e66d4fab72");
  });
});

describe("staged rows, as Convex's (STUDY-106 §7.1)", () => {
  test("a push makes one pending row per staged table; activation keeps it; the next activation's old rows go", async () => {
    const e = await open(tmp());
    const s1 = withStaged({ a: v.union(v.number(), v.string()) } as never);
    const hash = stagedValidatorsOf(schemaToJson(s1)).get("t")!.hash;
    const p = await e.startSchemaPush(s1);
    expect(await rows(e)).toEqual([
      expect.objectContaining({
        schemaId: p.schemaId,
        tableName: "t",
        validatorHash: hash,
        state: { state: "pending" },
        numDocsValidated: 0n,
        totalDocs: null,
      }),
    ]);
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
    await e.commitSchemaPush(p.schemaId, async () => {});
    expect((await rows(e)).map((r) => [r.schemaId, r.tableName])).toEqual([[p.schemaId, "t"]]);
    // No staged validator any more: the new schema has no row, the old active one's went with it.
    await push(e, defineSchema({ t: defineTable(enforced) }));
    expect(await rows(e)).toEqual([]);
  });

  test("an enforced row has no validatorHash field and goes at activation; the staged row stays", async () => {
    const e = await open(tmp());
    await push(e, defineSchema({ t: defineTable(v.any()), u: defineTable(v.any()) }));
    await e.mutation(async (db) => {
      for (let i = 0; i < 3; i++) await db.insert("u", { n: i % 2 });
    });
    await e.summariesReady();
    const s = defineSchema({
      t: defineTable(v.any()).staged({ b: v.string() }),
      u: defineTable({ n: v.union(v.literal(0), v.literal(1)) }),
    });
    const p = await e.startSchemaPush(s);
    await until(async () => (await rows(e)).some((r) => r.tableName === "u" && r.state.state === "valid"));
    const before = await rows(e);
    expect(before.map((r) => [r.tableName, "validatorHash" in r])).toEqual(
      expect.arrayContaining([
        ["t", true],
        ["u", false],
      ]),
    );
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
    await e.commitSchemaPush(p.schemaId, async () => {});
    expect((await rows(e)).map((r) => r.tableName)).toEqual(["t"]);
  });

  test("carry-over: a valid row when the new validator accepts everything the old one did; a pending one only for the same validator; never a failed one", async () => {
    const e = await open(tmp());
    await push(
      e,
      defineSchema({
        t: defineTable(enforced).staged({ a: v.number() }),
        u: defineTable(enforced).staged({ a: v.number() }),
        w: defineTable(enforced).staged({ a: v.number() }),
        x: defineTable(enforced).staged({ a: v.number() }),
      }),
    );
    const id = async (t: string) => (await rows(e)).find((r) => r.tableName === t)!._id;
    await setRow(e, await id("t"), { state: "valid" }, 10n, 10n);
    await setRow(e, await id("u"), { state: "valid" }, 10n, 10n);
    await setRow(e, await id("w"), { state: "failed", error: "no" } as never, 3n, 10n);
    await setRow(e, await id("x"), { state: "pending" }, 4n, 10n);
    const next = defineSchema({
      // Widened: the proof holds. Narrowed: it does not.
      t: defineTable(enforced).staged({ a: v.union(v.number(), v.string()) }),
      u: defineTable(enforced).staged({ a: v.literal(1) }),
      // Failed: starts over, even unchanged.
      w: defineTable(enforced).staged({ a: v.number() }),
      // Pending, unchanged: keeps its progress; with another field it would start over.
      x: defineTable(enforced).staged({ a: v.number() }),
      y: defineTable(enforced),
    });
    const p = await e.startSchemaPush(next);
    const mine = (await rows(e)).filter((r) => r.schemaId === p.schemaId);
    const hashes = stagedValidatorsOf(schemaToJson(next));
    expect(mine.map((r) => [r.tableName, r.validatorHash, r.state.state, r.numDocsValidated, r.totalDocs])).toEqual([
      ["t", hashes.get("t")!.hash, "valid", 10n, 10n],
      ["u", hashes.get("u")!.hash, "pending", 0n, null],
      ["w", hashes.get("w")!.hash, "pending", 0n, null],
      ["x", hashes.get("x")!.hash, "pending", 4n, 10n],
    ]);
    // An in-progress schema's rows are carried too when a newer push overwrites it.
    await setRow(e, mine.find((r) => r.tableName === "u")!._id, { state: "valid" }, 7n, 7n);
    const newer = defineSchema({
      t: defineTable(enforced).staged({ a: v.union(v.number(), v.string()) }),
      u: defineTable(enforced).staged({ a: v.union(v.literal(1), v.literal(2)) }),
    });
    const q = await e.startSchemaPush(newer);
    const theirs = (await rows(e)).filter((r) => r.schemaId === q.schemaId);
    expect(theirs.map((r) => [r.tableName, r.state.state, r.numDocsValidated])).toEqual([
      ["t", "valid", 10n],
      ["u", "valid", 7n],
    ]);
    // The overwritten schema's rows are gone.
    expect((await rows(e)).some((r) => r.schemaId === p.schemaId)).toBe(false);
  });

  test("a push of the same schema retries its failed staged rows whose hash is current", async () => {
    const e = await open(tmp());
    const s = withStaged({ a: v.union(v.number(), v.string()) } as never);
    const id = await push(e, s);
    const [row] = await rows(e);
    await setRow(e, row!._id, { state: "failed", error: "no" } as never, 2n, 5n);
    await push(e, s);
    expect(await rows(e)).toEqual([
      expect.objectContaining({ schemaId: id, state: { state: "pending" }, numDocsValidated: 0n, totalDocs: null }),
    ]);
  });

  test("at a start, the active schema's staged rows start over as pending; a pending schema's go (2ada334)", async () => {
    const path = tmp();
    const a = await open(path);
    const active = await push(a, withStaged({ a: v.union(v.number(), v.string()) } as never));
    await setRow(a, (await rows(a))[0]!._id, { state: "valid" }, 9n, 9n);
    // A pending schema held back by an index still building.
    const pending = defineSchema({
      t: defineTable(enforced)
        .staged({ a: v.union(v.number(), v.string()) })
        .index("by_a", ["a"]),
      u: defineTable(enforced).staged({ a: v.number() }),
    });
    await a.mutation(async (db) => {
      for (let i = 0; i < 2000; i++) await db.insert("t", { a: i });
    });
    const p = await a.startSchemaPush(pending);
    expect((await rows(a)).filter((r) => r.schemaId === p.schemaId)).toHaveLength(2);
    await a.close();
    engines.splice(engines.indexOf(a), 1);
    const b = await open(path);
    expect(await rows(b)).toEqual([
      expect.objectContaining({
        schemaId: active,
        tableName: "t",
        state: { state: "pending" },
        numDocsValidated: 0n,
        totalDocs: null,
      }),
    ]);
  });
});

describe("the guardrail: StagedSchemaWithEnforcedValidatorChanges (STUDY-106 §7.4)", () => {
  const message = (tables: string) =>
    `Cannot stage validators on tables whose enforced validator change needs their documents walked: ${tables}. Put the whole change in the staged validator instead, so the table is walked once, in the background.`;

  test("a staged table whose enforced change needs a walk is refused, tables by name; nothing is written", async () => {
    const e = await open(tmp());
    await push(e, defineSchema({ t: defineTable(enforced), s: defineTable(enforced) }));
    const s = defineSchema({
      t: defineTable({ a: v.literal(1) }).staged({ a: v.number() }),
      s: defineTable({ a: v.literal(2) }).staged({ a: v.number() }),
    });
    const err = e.stagedValidatorConflicts(s);
    expect(err).toBeInstanceOf(StagedSchemaError);
    expect(err!.code).toBe("StagedSchemaWithEnforcedValidatorChanges");
    expect(err!.message).toBe(message("s, t"));
    await expect(e.startSchemaPush(s)).rejects.toThrow(message("s, t"));
    expect(await rows(e)).toEqual([]);
  });

  test("an enforced change the active validator proves goes through; so does one without a staged validator, or a new table without an index", async () => {
    const e = await open(tmp());
    await push(e, defineSchema({ t: defineTable(enforced) }));
    expect(
      e.stagedValidatorConflicts(
        defineSchema({
          t: defineTable({ a: v.union(v.number(), v.string()) }).staged({ a: v.string() }),
          fresh: defineTable({ x: v.string() }).staged({ x: v.string() }),
          plain: defineTable({ x: v.literal("y") }),
        }),
      ),
    ).toBeNull();
    // A schema that does not validate needs no walk at all.
    const loose = defineSchema(
      { t: defineTable({ a: v.literal(1) }).staged({ a: v.number() }) },
      { schemaValidation: false },
    );
    expect(e.stagedValidatorConflicts(loose)).toBeNull();
  });

  test("a new table that declares an index counts as existing, as Convex's (its index creates it first)", async () => {
    const e = await open(tmp());
    for (const t of [
      defineTable({ x: v.string() }).index("by_x", ["x"]),
      defineTable({ x: v.string() }).searchIndex("s", { searchField: "x" }),
    ])
      expect(e.stagedValidatorConflicts(defineSchema({ u: t.staged({ x: v.string() }) }))?.message).toBe(message("u"));
  });
});
