// The workload the conformance suite runs through the engine: a tiny schema and the transaction bodies
// K3–K7 need. It uses the engine directly (no server, no function registry), so a third-party driver
// only has to depend on @bunvex/core and this package.
import { type Doc, defineSchema, defineTable, Engine, type Persistence, type Tx } from "@bunvex/core";
import { v } from "@bunvex/values";

export const schema = defineSchema({
  items: defineTable(v.any()).index("by_tenant_created", ["tenantId", "createdAt"]),
  counters: defineTable(v.any()).index("by_key", ["key"]),
});

/** The same schema with one more index on `items` (K24: added to a store that has documents, then backfilled). */
export const schemaWithAmount = defineSchema({
  items: defineTable(v.any()).index("by_tenant_created", ["tenantId", "createdAt"]).index("by_amount", ["amount"]),
  counters: defineTable(v.any()).index("by_key", ["key"]),
});

export const newEngine = (p: Persistence, opts?: ConstructorParameters<typeof Engine>[2]) =>
  new Engine(schema, p, opts).init();

export const insertItem = (tenantId: string) => (db: Tx) =>
  db.insert("items", {
    tenantId,
    title: "new item",
    status: "open",
    amount: Math.floor(Math.random() * 10_000),
    createdAt: Date.now(),
  });

export const seedCounters = (n: number) => async (db: Tx) => {
  for (let i = 0; i < n; i++) {
    const key = `k${i}`;
    const existing = await db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!existing) await db.insert("counters", { key, value: 0 });
  }
};

/** Read-modify-write: the lost-update detector (K3). */
export const increment = (key: string) => async (db: Tx) => {
  const row = await db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (!row) throw new Error(`counter ${key} not seeded`);
  await db.patch("counters", row._id, { value: (row.value as number) + 1 });
};

export const counter = (key: string) => async (db: Tx) =>
  ((
    await db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first()
  )?.value as number | undefined) ?? null;

export const listTenant =
  (tenantId: string, limit = 20) =>
  (db: Tx) =>
    db
      .query("items")
      .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(limit);

/** Two documents in ONE mutation: the atomic-visibility detector (K5). */
export const pair = (tenantId: string, tag: string) => async (db: Tx) => {
  await db.insert("items", { tenantId, title: `${tag}-a`, status: "open", amount: 1, createdAt: Date.now() });
  await db.insert("items", { tenantId, title: `${tag}-b`, status: "open", amount: 1, createdAt: Date.now() });
};

export const allOfTenant = (tenantId: string) => (db: Tx) =>
  db
    .query("items")
    .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId))
    .collect() as Promise<Doc[]>;

/** `n` documents of ~`pad` bytes each in ONE mutation (K26: a commit above a write batch's caps when large). */
export const insertPadded =
  (tenantId: string, n: number, pad: number, seq = 0) =>
  async (db: Tx) => {
    for (let i = 0; i < n; i++)
      await db.insert("items", {
        tenantId,
        title: "x".repeat(pad),
        status: "open",
        amount: seq,
        createdAt: Date.now(),
      });
  };
