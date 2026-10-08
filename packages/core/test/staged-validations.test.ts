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
// The staged walk off unless asked for: most tests look at the rows a push and its writes make.
const open = async (path: string, stagedWalk = false) => {
  const e = await new Engine(defineSchema({}), new SqlitePersistence(path, { durable: true }), {
    storedSchema: true,
    indexBackfill: { chunkRate: null },
    stagedWalk,
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
type Row = {
  _id: string;
  schemaId: string;
  tableName: string;
  validatorHash?: string;
  state: { state: string; error?: string };
};
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

  test("a start keeps every row, a valid one included (900fe2c: every write since is checked)", async () => {
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
    const before = await rows(a);
    expect(before.filter((r) => r.schemaId === p.schemaId)).toHaveLength(2);
    await a.close();
    engines.splice(engines.indexOf(a), 1);
    const b = await open(path);
    const after = await rows(b);
    expect(after.find((r) => r.schemaId === active)).toMatchObject({
      state: { state: "valid" },
      numDocsValidated: 9n,
      totalDocs: 9n,
    });
    expect(after.filter((r) => r.schemaId === p.schemaId).map((r) => [r.tableName, r.state.state])).toEqual([
      ["t", "valid"],
      ["u", "pending"],
    ]);
  });
});

describe("writes checked against staged validators, as Convex's (900fe2c, STUDY-106 §7.2)", () => {
  // The enforced validator lets `b` be anything; the staged one wants a string.
  const open_ = { a: v.number(), b: v.optional(v.any()) };
  const staged = defineSchema({ t: defineTable(open_).staged({ a: v.number(), b: v.string() }) });
  const failure = 'New document in table "t" does not match the schema: ';

  test("a write the staged validator refuses succeeds and fails the table's validation in its transaction; a conforming one changes nothing", async () => {
    const e = await open(tmp());
    await push(e, staged);
    await e.mutation((db) => db.insert("t", { a: 1, b: "ok" } as never));
    expect((await rows(e))[0]!.state).toEqual({ state: "pending" });
    const id = await e.mutation((db) => db.insert("t", { a: 2, b: 2 } as never));
    expect(await e.query((db) => db.get("t", id))).toMatchObject({ a: 2, b: 2 });
    // Convex's text, byte for byte (seen on its binary, a4ad353), and the table's hash with it.
    const [row] = await rows(e);
    expect(row!.state).toEqual({
      state: "failed",
      error: `${failure}Value does not match validator.\nPath: .b\nValue: 2.0\nValidator: v.string()`,
    });
    expect(row!.validatorHash).toBe("b4becbe27226cbdb5a87feb08b36c3e01f39027fa80d0749c5338f3d5cf08e13");
    // The enforced validator still refuses what it refuses.
    await expect(e.mutation((db) => db.insert("t", { a: "x" } as never))).rejects.toThrow(
      'Failed to insert or update a document in table "t" because it does not match the schema',
    );
  });

  test("a valid row fails too; a failed row keeps its first error; a replace is checked as an insert", async () => {
    const e = await open(tmp());
    await push(e, staged);
    const id = await e.mutation((db) => db.insert("t", { a: 1, b: "ok" } as never));
    await setRow(e, (await rows(e))[0]!._id, { state: "valid" }, 1n, 1n);
    await e.mutation((db) => db.replace("t", id, { a: 3 }));
    const first = (await rows(e))[0]!.state as { state: string; error: string };
    expect(first.state).toBe("failed");
    await e.mutation((db) => db.insert("t", { a: 4, b: 5 } as never));
    expect((await rows(e))[0]!.state).toEqual(first);
  });

  test("a mutation that fails, or a nested one rolled back, leaves the validation as it was", async () => {
    const e = await open(tmp());
    await push(e, staged);
    await expect(
      e.mutation(async (db) => {
        await db.insert("t", { a: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await e.mutation(async (db) => {
      const sp = db.begin();
      await db.insert("t", { a: 1 });
      db.rollback(sp);
    });
    expect((await rows(e))[0]!.state).toEqual({ state: "pending" });
  });

  test("the in-progress schema's staged validators are checked too, each schema's row on its own; schemaValidation does not matter", async () => {
    const e = await open(tmp());
    await push(e, defineSchema({ t: defineTable(open_).staged(open_) }, { schemaValidation: false }));
    await e.mutation(async (db) => {
      for (let i = 0; i < 2000; i++) await db.insert("t", { a: i });
    });
    // Pending behind an index still building; its staged validator wants `b`.
    const p = await e.startSchemaPush(
      defineSchema(
        {
          t: defineTable(open_)
            .staged({ a: v.number(), b: v.optional(v.string()) })
            .index("by_a", ["a"]),
        },
        { schemaValidation: false },
      ),
    );
    await e.mutation((db) => db.insert("t", { a: 1, b: 2 } as never));
    const byId = Object.fromEntries((await rows(e)).map((r) => [r.schemaId === p.schemaId ? "pending" : "active", r]));
    expect(byId.active!.state).toEqual({ state: "pending" });
    expect(byId.pending!.state.state).toBe("failed");
    await e.mutation((db) => db.insert("t", { a: "x" } as never));
    const again = Object.fromEntries((await rows(e)).map((r) => [r.schemaId === p.schemaId ? "pending" : "active", r]));
    expect(again.active!.state.state).toBe("failed");
  });
});

describe("the staged walk in the background, as Convex's (e049178, STUDY-106 §7.3)", () => {
  // The case seen on Convex's binary (02fe59b): a table walked to valid, one failed at its bad document, one the
  // shape proves (valid, no walk), one empty.
  const before = defineSchema({ t: defineTable(v.any()), u: defineTable(v.any()), w: defineTable(v.any()) });
  const after = defineSchema({
    t: defineTable(v.any()).staged({ a: v.union(v.literal(0), v.literal(1)) }),
    u: defineTable(v.any()).staged({ a: v.number(), s: v.string() }),
    w: defineTable(v.any()).staged({ a: v.number() }),
    n: defineTable(v.any()).staged({ q: v.string() }),
  });
  const fill = async (e: Engine) => {
    let bad = "";
    await e.mutation(async (db) => {
      for (let i = 0; i < 30; i++) await db.insert("t", { a: i % 2 });
      for (let i = 0; i < 29; i++) await db.insert("u", { a: i, s: "x" });
      bad = await db.insert("u", { a: "bad", s: "x" });
      for (let i = 0; i < 30; i++) await db.insert("w", { a: i });
    });
    await e.summariesReady();
    return bad;
  };
  const byTable = async (e: Engine) => Object.fromEntries((await rows(e)).map((r) => [r.tableName, r]));

  test("walked to valid, failed at the first bad document, proven by the shape, empty: as on Convex's binary", async () => {
    const e = await open(tmp(), true);
    await push(e, before);
    const bad = await fill(e);
    await push(e, after);
    await e.stagedWalkIdle();
    const r = await byTable(e);
    expect(r.t).toMatchObject({ state: { state: "valid" }, numDocsValidated: 30n, totalDocs: 30n });
    expect(r.u!.state).toEqual({
      state: "failed",
      error: `Document with ID "${bad}" in table "u" does not match the schema: Value does not match validator.\nPath: .a\nValue: "bad"\nValidator: v.float64()`,
    });
    expect(r.w).toMatchObject({ state: { state: "valid" }, numDocsValidated: 0n, totalDocs: null });
    expect(r.n).toMatchObject({ state: { state: "valid" }, numDocsValidated: 0n, totalDocs: null });
    // The schema itself is never touched.
    expect((await e.schemaPushStatus((await rows(e))[0]!.schemaId)).type).toBe("complete");
  });

  test("rows left pending are walked after a restart; a pushed schema still in progress has its rows walked too", async () => {
    const path = tmp();
    const a = await open(path);
    await push(a, before);
    await fill(a);
    await push(a, after);
    expect(Object.values(await byTable(a)).map((r) => r.state.state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    await a.close();
    engines.splice(engines.indexOf(a), 1);
    const b = await open(path, true);
    await b.stagedWalkIdle();
    expect(Object.fromEntries(Object.entries(await byTable(b)).map(([t, r]) => [t, r.state.state]))).toEqual({
      t: "valid",
      u: "failed",
      w: "valid",
      n: "valid",
    });
    // In progress (held back by an index building): its own rows are walked while it waits. `u` failed under the
    // active schema, so nothing is carried over: only the walk can make the corrected validator's row valid.
    await b.mutation(async (db) => {
      for (let i = 0; i < 2000; i++) await db.insert("u", { a: i, s: "x" });
    });
    const p = await b.startSchemaPush(
      defineSchema({
        u: defineTable(v.any())
          .staged({ a: v.union(v.number(), v.string()), s: v.string() })
          .index("by_a", ["a"]),
      }),
    );
    expect((await b.schemaPushStatus(p.schemaId)).type).toBe("inProgress");
    await b.stagedWalkIdle();
    expect((await rows(b)).find((r) => r.schemaId === p.schemaId)?.state).toEqual({ state: "valid" });
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
