// SPIKE (STUDY-28 §3.3.2): a better-auth database adapter over a bunvex transaction. Inside an execution it
// uses the current Tx (one OCC transaction for the whole endpoint); outside one (an action), each call is
// its own short engine query / mutation, and `transaction(cb)` runs cb inside ONE engine mutation.
import { AsyncLocalStorage } from "node:async_hooks";
import { type Engine, type Tx, withRealCrypto } from "@bunvex/core";
import { createAdapterFactory } from "better-auth/adapters";

export const currentTx = new AsyncLocalStorage<{ tx: Tx; write: boolean }>();
export const adapterStats = { calls: 0, outsideCalls: 0, transactions: 0 };

type Where = { field: string; value: unknown; operator: string; connector: "AND" | "OR"; mode?: string };

/** Single-field indexes the spike schema declares: `${model}.${field}` → index name. */
export type IndexMap = Record<string, string>;

export function bunvexAdapter(engine: Engine, indexes: IndexMap) {
  const withTx = async <T>(write: boolean, f: (tx: Tx) => Promise<T>): Promise<T> => {
    adapterStats.calls++;
    const cur = currentTx.getStore();
    if (cur) {
      if (write && !cur.write) throw new Error("SPIKE: a write from a query execution");
      return f(cur.tx);
    }
    adapterStats.outsideCalls++;
    return write
      ? engine.mutation((tx) => currentTx.run({ tx, write: true }, () => withRealCrypto(() => f(tx))))
      : engine.query((tx) => currentTx.run({ tx, write: false }, () => f(tx)));
  };

  const out = (doc: Record<string, unknown> | null) => {
    if (!doc) return null;
    const { _id, _creationTime, ...rest } = doc;
    return { ...rest, id: _id };
  };

  const test = (doc: Record<string, unknown>, c: Where) => {
    const v = c.field === "id" ? doc._id : doc[c.field];
    const ci = c.mode === "insensitive";
    const s = (x: unknown) => (ci && typeof x === "string" ? x.toLowerCase() : x);
    const val = s(c.value) as never;
    switch (c.operator) {
      case "in":
        return (c.value as unknown[]).map(s).includes(s(v));
      case "not_in":
        return !(c.value as unknown[]).map(s).includes(s(v));
      case "contains":
        return typeof v === "string" && (s(v) as string).includes(val);
      case "starts_with":
        return typeof v === "string" && (s(v) as string).startsWith(val);
      case "ends_with":
        return typeof v === "string" && (s(v) as string).endsWith(val);
      case "ne":
        return s(v) !== val;
      case "gt":
        return c.value != null && (v as never) > val;
      case "gte":
        return c.value != null && (v as never) >= val;
      case "lt":
        return c.value != null && (v as never) < val;
      case "lte":
        return c.value != null && (v as never) <= val;
      default:
        return c.value === null ? v == null : s(v) === val;
    }
  };
  const matches = (doc: Record<string, unknown>, where: Where[]) => {
    if (where.length === 0) return true;
    let r = test(doc, where[0]);
    for (const c of where.slice(1)) r = c.connector === "OR" ? r || test(doc, c) : r && test(doc, c);
    return r;
  };

  /** The candidate rows: by id, by a single-field index on an AND-only eq, else a full scan. */
  const candidates = async (tx: Tx, model: string, where: Where[]): Promise<Record<string, unknown>[]> => {
    const andOnly = where.every((c, i) => i === 0 || c.connector !== "OR");
    const eq = andOnly ? where.find((c) => (c.operator ?? "eq") === "eq" && c.mode !== "insensitive") : undefined;
    if (eq?.field === "id") {
      const id = tx.normalizeId(model, String(eq.value));
      const d = id ? await tx.get(model, id) : null;
      return d ? [d as Record<string, unknown>] : [];
    }
    const index = eq && indexes[`${model}.${eq.field}`];
    const q = index
      ? tx.query(model).withIndex(index, (b) => b.eq(eq.field, eq.value as never))
      : tx.query(model).fullTableScan();
    return (await q.collect()) as Record<string, unknown>[];
  };
  const find = async (tx: Tx, model: string, where: Where[]) =>
    (await candidates(tx, model, where ?? [])).filter((d) => matches(d, where ?? []));

  const factory = createAdapterFactory({
    config: {
      adapterId: "bunvex-spike",
      adapterName: "bunvex (spike)",
      usePlural: false,
      disableIdGeneration: true,
      supportsDates: false,
      supportsBooleans: true,
      supportsJSON: false,
      supportsArrays: false,
      supportsNumericIds: false,
      transaction: async (cb) => {
        adapterStats.transactions++;
        // Inside an execution: the endpoint already is one transaction. Outside: one engine mutation.
        if (currentTx.getStore()) return cb(lazy());
        return engine.mutation((tx) => currentTx.run({ tx, write: true }, () => withRealCrypto(() => cb(lazy()))));
      },
    },
    adapter: () => ({
      create: async ({ model, data }) =>
        withTx(true, async (tx) => {
          const clean = Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== "id" && v !== undefined));
          const id = await tx.insert(model, clean);
          return out((await tx.get(model, id)) as Record<string, unknown>) as never;
        }),
      findOne: async ({ model, where }) =>
        withTx(false, async (tx) => (out((await find(tx, model, where as Where[]))[0] ?? null) ?? null) as never),
      findMany: async ({ model, where, limit, offset, sortBy }) =>
        withTx(false, async (tx) => {
          let rows = await find(tx, model, (where ?? []) as Where[]);
          if (sortBy) {
            const k = sortBy.field;
            rows = rows.sort((a, b) => {
              const x = a[k] as never;
              const y = b[k] as never;
              const c = x < y ? -1 : x > y ? 1 : 0;
              return sortBy.direction === "asc" ? c : -c;
            });
          }
          return rows.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100)).map(out) as never;
        }),
      count: async ({ model, where }) =>
        withTx(false, async (tx) => (await find(tx, model, (where ?? []) as Where[])).length),
      update: async ({ model, where, update }) =>
        withTx(true, async (tx) => {
          const [d] = await find(tx, model, where as Where[]);
          if (!d) return null;
          await tx.patch(model, d._id as string, update as Record<string, unknown>);
          return out((await tx.get(model, d._id as string)) as Record<string, unknown>) as never;
        }),
      updateMany: async ({ model, where, update }) =>
        withTx(true, async (tx) => {
          const rows = await find(tx, model, where as Where[]);
          for (const d of rows) await tx.patch(model, d._id as string, update as Record<string, unknown>);
          return rows.length;
        }),
      delete: async ({ model, where }) =>
        withTx(true, async (tx) => {
          const [d] = await find(tx, model, where as Where[]);
          if (d) await tx.delete(model, d._id as string);
        }),
      deleteMany: async ({ model, where }) =>
        withTx(true, async (tx) => {
          const rows = await find(tx, model, where as Where[]);
          for (const d of rows) await tx.delete(model, d._id as string);
          return rows.length;
        }),
    }),
  });
  let options: unknown;
  const lazy = () => factory(options as never);
  return (opts: unknown) => {
    options = opts;
    return factory(opts as never);
  };
}
