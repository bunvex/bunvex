// Edges of tx.ts's first part (TEST-01 §7, mutation triage): index ranges' rules and messages, `formatBytes`,
// the nesting check of a written value, a patch's JSON in the lone-surrogate message, the metered I/O
// (`io`) and the limit warnings' biggest writes (`biggestWrites`), the read limits a system transaction
// skips, uncounted reads, commit timestamps, the `_tables` read a table use records, and a non-limit
// error in `paginate`.
import { describe, expect, test } from "bun:test";
import { commitTsPlaceholder, v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { encodeKey, prefixEnd } from "../src/keyenc.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { formatBytes, ImportIdError, Tx } from "../src/tx.ts";

async function engine() {
  return await new Engine(
    defineSchema({
      t: defineTable(v.any()).index("by_k", ["k"]).index("by_ab", ["a", "b"]),
      t_: defineTable(v.any()),
      s: defineTable(v.any()).searchIndex("sb", { searchField: "body" }),
      vv: defineTable(v.any()).vectorIndex("ve", { vectorField: "e", dimensions: 2 }),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
}

const message = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not fail");
};

/** The transaction a mutation ran in, to read what it metered after its commit. */
async function mutationTx(e: Engine, body: (db: Tx) => Promise<unknown>): Promise<Tx> {
  let tx!: Tx;
  await e.mutation(async (db) => {
    tx = db as Tx;
    await body(tx);
  });
  return tx;
}

describe("index ranges", () => {
  test("by_id lists no fields; a bound on a field the index lacks; fields out of order; lte includes", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("t", { k: 1, a: 1, b: 1 }));
    expect(
      await message(
        e.query((db) =>
          db
            .query("t")
            .withIndex("by_id", (q) => q.eq("x", 1))
            .collect(),
        ),
      ),
    ).toBe('The index range included a comparison with "x", but t.by_id with fields [] doesn\'t index this field.');
    // An inequality alone on a field the index lacks: "doesn't index", not "out of order".
    expect(
      await message(
        e.query((db) =>
          db
            .query("t")
            .withIndex("by_k", (q) => q.gt("zz", 1))
            .collect(),
        ),
      ),
    ).toBe(
      'The index range included a comparison with "zz", but t.by_k with fields ["k", "_creationTime"] doesn\'t index this field.',
    );
    // An inequality on the second field without an equality on the first.
    expect(
      await message(
        e.query((db) =>
          db
            .query("t")
            .withIndex("by_ab", (q) => q.gt("b", 0))
            .collect(),
        ),
      ),
    ).toStartWith("Tried to query index t.by_ab but the query didn't use the index fields in order.");
    expect(
      await e.query((db) =>
        db
          .query("t")
          .withIndex("by_k", (q) => q.lte("k", 1))
          .collect(),
      ),
    ).toHaveLength(1);
    expect(
      await e.query((db) =>
        db
          .query("t")
          .withIndex("by_k", (q) => q.lt("k", 1))
          .collect(),
      ),
    ).toHaveLength(0);
  });
});

test("formatBytes: binary units, two decimals past bytes, the largest unit kept past it", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KiB");
  expect(formatBytes(1100000)).toBe("1.05 MiB");
  expect(formatBytes(1024 ** 3)).toBe("1 GiB");
  expect(formatBytes(1024 ** 4)).toBe("1 TiB");
  expect(formatBytes(1024 ** 5)).toBe("1 PiB");
  expect(formatBytes(1024 ** 6)).toBe("1024 PiB");
});

test("ImportIdError carries its name and code", () => {
  const err = new ImportIdError("InvalidId", "bad");
  expect(err.name).toBe("ImportIdError");
  expect([err.code, err.message]).toEqual(["InvalidId", "bad"]);
});

test("a written array as deep as the value nesting limit (64) is the argument's error", async () => {
  const e = await engine();
  const arrays = (n: number): unknown => (n === 0 ? 1 : [arrays(n - 1)]);
  // The 64th array sits 64 levels down: refused while the value is read, before the document is checked.
  expect(await message(e.mutation((db) => db.insert("t", { z: arrays(64) })))).toStartWith(
    "Invalid argument `value` for `db.insert`: ",
  );
  // One less passes the argument's check and fails the document's (16 levels).
  expect(await message(e.mutation((db) => db.insert("t", { z: arrays(63) })))).toStartWith("Document(value: ");
});

test("a patch's lone surrogate: its JSON with the fields sorted", async () => {
  const e = await engine();
  const id = await e.mutation((db) => db.insert("t", {}));
  // The parse error's column is past `"value":{"a":"\ud800`: with `b` first it would be further on.
  expect(await message(e.mutation((db) => db.patch(id, { b: 2, a: "\ud800" })))).toBe(
    "Received invalid json: unexpected end of hex escape at line 1 column 62",
  );
});

describe("io(): what a transaction read and wrote, as Convex meters it", () => {
  const ZERO = {
    readBytes: 0,
    readDocuments: 0,
    writeBytes: 0,
    writeDocuments: 0,
    writeIndexRows: 0,
    textQueryBytes: 0,
    textWriteBytes: 0,
    vectorWriteBytes: 0,
    vectorWriteQueryBytes: 0,
  };

  test("an insert: one document, a row per index, its size and its user index keys' bytes", async () => {
    const e = await engine();
    // `t_` has the system indexes only; `t` adds by_k and by_ab. The same document, 79 bytes.
    const plain = await mutationTx(e, (db) => db.insert("t_", { k: 1, x: "a" }));
    expect(plain.io(true)).toEqual({ ...ZERO, writeBytes: 79, writeDocuments: 1, writeIndexRows: 2 });
    const indexed = await mutationTx(e, (db) => db.insert("t", { k: 1, x: "a" }));
    const io = indexed.io(true);
    expect(io).toMatchObject({ writeDocuments: 1, writeIndexRows: 4 });
    expect(io.writeBytes).toBeGreaterThan(79 + 2 * 40); // two user index keys, each past 40 bytes
    // Not committed: no writes.
    expect(indexed.io(false)).toEqual(ZERO);
  });

  test("a patch: an index row per index whose key stays, two where it moves; a delete adds no bytes", async () => {
    const e = await engine();
    let id = "";
    const inserted = await mutationTx(e, async (db) => {
      id = await db.insert("t_", { k: 1 });
    });
    const same = await mutationTx(e, (db) => db.patch(id, { x: "b" }));
    const sameIo = same.io(true);
    expect(sameIo).toMatchObject({ writeDocuments: 1, writeIndexRows: 2, readDocuments: 1 });
    // A get by id: the document's size only, no key bytes (a system index).
    expect(sameIo.readBytes).toBe(inserted.io(true).writeBytes);
    const tid = await e.mutation((db) => db.insert("t", { k: 1, a: 1, b: 1 }));
    const unmoved = await mutationTx(e, (db) => db.patch(tid, { x: "b" }));
    expect(unmoved.io(true).writeIndexRows).toBe(4);
    const moved = await mutationTx(e, (db) => db.patch(tid, { k: 2 }));
    expect(moved.io(true).writeIndexRows).toBe(5);
    const deleted = await mutationTx(e, (db) => db.delete(tid));
    expect(deleted.io(true)).toMatchObject({ writeDocuments: 1, writeIndexRows: 4, writeBytes: 0 });
    // Inserted and deleted in the same transaction: nothing written.
    const gone = await mutationTx(e, async (db) => db.delete(await db.insert("t", { k: 3 })));
    expect(gone.io(true)).toMatchObject({ writeDocuments: 0, writeIndexRows: 0, writeBytes: 0 });
  });

  test("text and vector index writes", async () => {
    const e = await engine();
    const text = await mutationTx(e, (db) => db.insert("s", { body: "hello world" }));
    expect(text.io(true)).toMatchObject({ textWriteBytes: 11, vectorWriteBytes: 0, vectorWriteQueryBytes: 0 });
    // One document in the vector index (2 dimensions: 2 × 4 + 33 bytes), one not in it.
    const vec = await mutationTx(e, async (db) => {
      await db.insert("vv", { e: [1, 2] });
      await db.insert("vv", { f: 1 });
    });
    const io = vec.io(true);
    expect(io).toMatchObject({ writeDocuments: 2, vectorWriteQueryBytes: 41, textWriteBytes: 0 });
    const inIndex = await mutationTx(e, (db) => db.insert("vv", { e: [1, 2] }));
    expect(io.vectorWriteBytes).toBe(inIndex.io(true).writeBytes);
  });

  test("reads through a user index add its key bytes", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("t", { k: 1, a: 1, b: 1 }));
    let byIndex!: Tx;
    let byTable!: Tx;
    await e.query(async (db) => {
      byIndex = db as Tx;
      await db.query("t").withIndex("by_k").collect();
    });
    await e.query(async (db) => {
      byTable = db as Tx;
      await db.query("t").collect();
    });
    const [ki, kt] = [byIndex.io(false), byTable.io(false)];
    expect([ki.readDocuments, kt.readDocuments]).toEqual([1, 1]);
    expect(kt.readBytes).toBe(byTable.usage.bytesRead);
    expect(ki.readBytes).toBeGreaterThan(kt.readBytes);
  });

  test("a transaction with no search or vector indexes attached", async () => {
    const e = await engine();
    const snapshot = await e.query(async (db) => (db as Tx).snapshot);
    const tx = new Tx(e.catalog, e.persistence, snapshot, true, Date.now(), true);
    await tx.insert("t_", { k: 1 });
    expect(tx.io(true)).toMatchObject({ writeDocuments: 1, textWriteBytes: 0, vectorWriteBytes: 0 });
  });
});

describe("biggestWrites()", () => {
  test("the largest and the most nested document, the first on a tie; none for deletes only", async () => {
    const e = await engine();
    let ids: string[] = [];
    const tx = await mutationTx(e, async (db) => {
      ids = [
        await db.insert("t", { x: "aa" }),
        await db.insert("t", { x: "bb" }), // the same size: the first stays
        await db.insert("t", { x: { y: 1 } }),
        await db.insert("t", { x: "a".repeat(50) }),
      ];
    });
    const b = tx.biggestWrites()!;
    expect(b.maxSize[0]).toBe(ids[3]!);
    expect(b.maxNesting).toEqual([ids[2]!, 2]);
    const ties = await mutationTx(e, async (db) => {
      ids = [await db.insert("t", { x: "aa" }), await db.insert("t", { x: "bb" })];
    });
    const t = ties.biggestWrites()!;
    expect(t.maxSize[0]).toBe(ids[0]!);
    expect(t.maxNesting).toEqual([ids[0]!, 1]);
    const del = await mutationTx(e, (db) => db.delete(ids[0]!));
    expect(del.biggestWrites()).toBeNull();
  });

  test("system tables are left out", async () => {
    const e = await engine();
    const snapshot = await e.query(async (db) => (db as Tx).snapshot);
    const tx = new Tx(e.catalog, e.persistence, snapshot, true, Date.now(), true);
    await tx.insert("_backend_state", { system: "running", user: "running", usage_limit: "none" });
    expect(tx.biggestWrites()).toBeNull();
    const id = await tx.insert("t_", { k: 1 });
    expect(tx.biggestWrites()!.maxSize[0]).toBe(id);
  });
});

test("a system transaction reads past the read limits", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    await db.insert("t_", { k: 1 });
    await db.insert("t_", { k: 2 });
  });
  const snapshot = await e.query(async (db) => (db as Tx).snapshot);
  const tx = new Tx(e.catalog, e.persistence, snapshot, false, Date.now(), true);
  tx.limits.documentsRead = 1;
  tx.limits.bytesRead = 1;
  expect(await tx.query("t_").collect()).toHaveLength(2);
});

test("a read kept out of the limits does not count as a query", async () => {
  const e = await engine();
  const counts = await e.query(async (db) => {
    const tx = db as Tx;
    const before = tx.usage.databaseQueries;
    tx.recordUncounted(e.catalog.table("t").byId.id);
    return [before, tx.usage.databaseQueries];
  });
  expect(counts[1]).toBe(counts[0]);
});

describe("commit timestamps", () => {
  test("resolved at commit and then gone; a document deleted after holding one leaves nothing to resolve", async () => {
    const e = await engine();
    const tx = await mutationTx(e, async (db) => {
      await db.insert("t_", { at: db.vars!.commitTs });
      const gone = await db.insert("t_", { at: db.vars!.commitTs });
      await db.delete(gone);
      // A read of nothing while a placeholder is pending hands out nothing.
      expect(await db.get(gone)).toBeNull();
      expect(tx_hasCommitTs(db)).toBe(true);
    });
    expect(tx.hasCommitTs).toBe(false);
    const rows = await e.query((db) => db.query("t_").collect());
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.at).toBe("bigint");
    expect(rows[0]!.at).not.toBe(commitTsPlaceholder);
  });
});
const tx_hasCommitTs = (db: Tx) => db.hasCommitTs;

test("a table's use records a read of its `_tables` row (a subscription's run included)", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("t", { k: 1 }));
  const t = e.catalog.table("t");
  const tables = e.catalog.table("_tables").byId.id;
  const k = encodeKey([t.metaId!]);
  const run = await e.queryTracked((db) => db.query("t").collect());
  const onTables = run.reads.filter((r) => r.index === tables);
  expect(onTables).toEqual([{ index: tables, lo: k, hi: prefixEnd(k) }]);
});

test("paginate: an error that is not a transaction limit fails the function", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("t", { k: 1 }));
  const p = e.query(async (db) => {
    (db as Tx).retention = {
      check() {
        throw new Error("out of retention");
      },
    };
    return await db.query("t").paginate({ numItems: 5, cursor: null });
  });
  expect(await message(p)).toBe("out of retention");
});

test("a transaction outside an engine has no pagination cursors", async () => {
  const e = await engine();
  const snapshot = await e.query(async (db) => (db as Tx).snapshot);
  const tx = new Tx(e.catalog, e.persistence, snapshot, false, Date.now(), true);
  expect(() => tx.cursorCodec()).toThrow("pagination cursors need an initialized engine");
});
