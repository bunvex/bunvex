// The index id allocator (STUDY-128), as Convex's `_next_persistence_index_id`
// (crates/database/src/bootstrap_model/next_persistence_index_id): one document `{nextId}`, the id the next
// index gets. Every transaction that creates indexes takes its ids from it and writes it back in the same
// commit, so two of them conflict on it; it never goes down, so a dropped index's id is never reused.
import { NEXT_PERSISTENCE_INDEX_ID_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

type Counter = { _id: string; nextId: bigint };

const readCounter = (db: Tx) =>
  db.asSystem(() => db.query(NEXT_PERSISTENCE_INDEX_ID_TABLE).first()) as Promise<Counter | null>;

/** The next index id, or undefined before the store's first start has written the counter. */
export async function readNextIndexId(db: Tx): Promise<number | undefined> {
  const row = await readCounter(db);
  return row ? Number(row.nextId) : undefined;
}

/**
 * Record that ids below `next` are taken (Convex's `allocate`): raise the counter, never lower it. Before
 * the counter exists (the first start's catalog commit creates its table, which that transaction cannot
 * write yet), the first call after it writes it.
 */
export async function writeNextIndexId(db: Tx, next: number): Promise<void> {
  if (!db.hasTable(NEXT_PERSISTENCE_INDEX_ID_TABLE)) return;
  const row = await readCounter(db);
  if (!row) await db.asSystem(() => db.insert(NEXT_PERSISTENCE_INDEX_ID_TABLE, { nextId: BigInt(next) }));
  else if (BigInt(next) > row.nextId)
    await db.asSystem(() => db.patch(NEXT_PERSISTENCE_INDEX_ID_TABLE, row._id, { nextId: BigInt(next) }));
}
