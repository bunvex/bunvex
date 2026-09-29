// The convex-bench functions, mirroring ~/sandbox/convex-bench/convex/bench.ts: same names, arguments
// and semantics (so the same k6 script and fan-out harness run unchanged).
import { action, mutation, query, Schema } from "bunvex/server";

export const benchSchema = new Schema()
  .table("items", { by_tenant_created: ["tenantId", "createdAt"] })
  .table("counters", { by_key: ["key"] })
  .table("messages", { by_room_sent: ["room", "sentAt"] });

const PAGE = 20;

export const bench = {
  seedItems: mutation(async ({ db }, { tenants, perTenant, tenantOffset }) => {
    const now = Date.now();
    for (let t = tenantOffset; t < tenantOffset + tenants; t++)
      for (let i = 0; i < perTenant; i++)
        await db.insert("items", {
          tenantId: `t${t}`,
          title: `item ${i} of tenant ${t}`,
          status: i % 3 === 0 ? "done" : "open",
          amount: Math.floor(Math.random() * 10_000),
          createdAt: now - i * 1000,
        });
    return null;
  }),

  seedCounters: mutation(async ({ db }, { n }) => {
    for (let i = 0; i < n; i++) {
      const key = `k${i}`;
      const existing = await db
        .query("counters")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (!existing) await db.insert("counters", { key, value: 0 });
    }
    return null;
  }),

  listCached: query(async ({ db }) =>
    db
      .query("items")
      .withIndex("by_tenant_created", (q) => q.eq("tenantId", "t0"))
      .order("desc")
      .take(PAGE),
  ),

  listByTenant: query(async ({ db }, { tenantId }) =>
    db
      .query("items")
      .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(PAGE),
  ),

  insertItem: mutation(async ({ db }, { tenantId }) =>
    db.insert("items", {
      tenantId,
      title: "new item",
      status: "open",
      amount: Math.floor(Math.random() * 10_000),
      createdAt: Date.now(),
    }),
  ),

  increment: mutation(async ({ db }, { key }) => {
    const row = await db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!row) throw new Error(`counter ${key} not seeded`);
    await db.patch("counters", row._id, { value: (row.value as number) + 1 });
    return null;
  }),

  _latestForTenant: query(
    async ({ db }, { tenantId }) =>
      db
        .query("items")
        .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId))
        .order("desc")
        .first(),
    true,
  ),

  _insertInternal: mutation(async ({ db }, { tenantId, amount }) => {
    await db.insert("items", { tenantId, title: "from action", status: "open", amount, createdAt: Date.now() });
    return null;
  }, true),

  readThenWrite: action(async (ctx, { tenantId }) => {
    const latest = (await ctx.runQuery("bench:_latestForTenant", { tenantId })) as { amount: number } | null;
    await ctx.runMutation("bench:_insertInternal", { tenantId, amount: (latest?.amount ?? 0) + 1 });
    return null;
  }),

  latestMessage: query(async ({ db }, { room }) =>
    db
      .query("messages")
      .withIndex("by_room_sent", (q) => q.eq("room", room))
      .order("desc")
      .first(),
  ),

  postMessage: mutation(async ({ db }, { room, sentAt }) => {
    await db.insert("messages", { room, body: "ping", sentAt });
    return null;
  }),
};
