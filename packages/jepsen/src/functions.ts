// The functions the workload calls (STUDY-57 §3.2): a few small data types whose correct behaviour is easy to
// state, each in its own table. Every read takes an ignored `nonce`, so that a read is a fresh subscription
// evaluated by the server at its latest timestamp, not a result the client already holds (§2.3).
import { defineSchema, defineTable, type GenericDatabaseReader } from "@bunvex/core";
import { mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";

export const schema = defineSchema({
  registers: defineTable(v.any()).index("by_key", ["key"]),
  accounts: defineTable(v.any()).index("by_name", ["name"]),
  setItems: defineTable(v.any()),
  opsLog: defineTable(v.any()).index("by_client", ["client"]),
});

// biome-ignore lint/suspicious/noExplicitAny: the tables hold v.any() documents
type Db = GenericDatabaseReader<any>;
const register = (db: Db, key: string) =>
  db
    .query("registers")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
const account = (db: Db, name: string) =>
  db
    .query("accounts")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();

/** A register per key: read, write, compare-and-set. Values are unique per write (the workload's choice). */
export const reg = {
  read: query(async ({ db }, { key }: { key: string; nonce?: number }) => (await register(db, key))?.value ?? null),
  write: mutation(async ({ db }, { key, value }: { key: string; value: number }) => {
    const r = await register(db, key);
    if (r) await db.patch(r._id, { value });
    else await db.insert("registers", { key, value });
  }),
  cas: mutation(async ({ db }, { key, from, to }: { key: string; from: number | null; to: number }) => {
    const r = await register(db, key);
    if ((r?.value ?? null) !== from) return false;
    if (r) await db.patch(r._id, { value: to });
    else await db.insert("registers", { key, value: to });
    return true;
  }),
};

/** Accounts whose total never changes: transfers move money, reads see every balance at one snapshot. */
export const bank = {
  init: mutation(async ({ db }, { names, each }: { names: string[]; each: number }) => {
    if (await db.query("accounts").first()) return;
    for (const name of names) await db.insert("accounts", { name, balance: each });
  }),
  transfer: mutation(async ({ db }, { from, to, amount }: { from: string; to: string; amount: number }) => {
    const a = await account(db, from);
    const b = await account(db, to);
    if (!a || !b || a.balance < amount) return false;
    await db.patch(a._id, { balance: a.balance - amount });
    await db.patch(b._id, { balance: b.balance + amount });
    return true;
  }),
  all: query(async ({ db }, _args: { nonce?: number }) => {
    const out: Record<string, number> = {};
    for (const a of await db.query("accounts").collect()) out[a.name as string] = a.balance as number;
    return out;
  }),
  balance: query(async ({ db }, { name }: { name: string }) => (await account(db, name))?.balance ?? null),
};

/** A grow-only set of unique tokens: an insert per add, so a mutation that ran twice shows as a duplicate. */
export const set = {
  add: mutation(async ({ db }, { token }: { token: string }) => {
    await db.insert("setItems", { token });
  }),
  all: query(async ({ db }, _args: { nonce?: number }) =>
    (await db.query("setItems").collect()).map((r) => r.token as string),
  ),
};

/** Each client's mutations, appended in commit order: per-client order and exactly-once, checked at the end. */
export const log = {
  // Reads the client's latest entry first, so pipelined appends that ran concurrently would conflict and
  // retry — the order they commit in then shows whether the server kept them one at a time.
  append: mutation(async ({ db }, { client, seq }: { client: number; seq: number }) => {
    const last = await db
      .query("opsLog")
      .withIndex("by_client", (q) => q.eq("client", client))
      .order("desc")
      .first();
    await db.insert("opsLog", { client, seq, after: (last?.seq as number | undefined) ?? null });
  }),
  all: query(async ({ db }, _args: { nonce?: number }) =>
    (await db.query("opsLog").collect()).map((r) => [r.client as number, r.seq as number] as const),
  ),
  /** A client's entries in the default order, with their `_creationTime` (the regression test of a clock step). */
  rows: query(async ({ db }, { client }: { client: number; nonce?: number }) =>
    (
      await db
        .query("opsLog")
        .withIndex("by_client", (q) => q.eq("client", client))
        .collect()
    ).map((r) => [r.seq as number, r._creationTime as number] as const),
  ),
};
