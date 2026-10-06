// The tablet id allocator (STUDY-04 §7): one document `{nextId}`, the persistence id the next table gets. Convex
// gives each table a random UUID, so a table's id is never another's, even after a table was purged; bunvex's
// tablets are integers (a persistence key), so they come from this counter instead. Every transaction that
// creates tables takes its ids from it and writes it back in the same commit; it never goes down.
import { NEXT_TABLET_ID_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

type Counter = { _id: string; nextId: bigint };

const readCounter = (db: Tx) => db.asSystem(() => db.query(NEXT_TABLET_ID_TABLE).first()) as Promise<Counter | null>;

/** The next tablet id, or undefined before the store's first start has written the counter. */
export async function readNextTablet(db: Tx): Promise<number | undefined> {
  const row = await readCounter(db);
  return row ? Number(row.nextId) : undefined;
}

/**
 * Record that tablets below `next` are taken: raise the counter, never lower it. Before the counter exists
 * (the first start's catalog commit creates its table, which that transaction cannot write yet), the first
 * call after it writes it.
 */
export async function writeNextTablet(db: Tx, next: number): Promise<void> {
  if (!db.hasTable(NEXT_TABLET_ID_TABLE)) return;
  const row = await readCounter(db);
  if (!row) await db.asSystem(() => db.insert(NEXT_TABLET_ID_TABLE, { nextId: BigInt(next) }));
  else if (BigInt(next) > row.nextId)
    await db.asSystem(() => db.patch(NEXT_TABLET_ID_TABLE, row._id, { nextId: BigInt(next) }));
}
