// STUDY-168: the app module the measurements and escape tests run, both in today's executor (a `vm` code version)
// and in the sandboxed child. Its functions are `sb:<name>`. Schema: bench/functions.ts (`items`, `counters`).
import { action, mutation, query } from "bunvex/server";
import { v } from "bunvex/values";

// `nonce`: a distinct argument per call, so the benchmarks run the function instead of hitting the query cache.
const nonce = v.optional(v.number());

export const empty = query({ args: { nonce }, handler: async () => null });

/** `n` sequential `db.get`s. */
export const getMany = query({
  args: { ids: v.array(v.string()), nonce },
  handler: async ({ db }, { ids }) => {
    let found = 0;
    for (const id of ids) if (await db.get(id as never)) found++;
    return found;
  },
});

/** One index range page of `n` documents. */
export const page = query({
  args: { n: v.number(), nonce },
  handler: async ({ db }, { n }) =>
    (
      await db
        .query("items")
        .withIndex("by_tenant_created", (q) => q.eq("tenantId", "t0"))
        .order("desc")
        .take(n)
    ).length,
});

/** convex-bench's `listByTenant`: a page of 20. */
export const listByTenant = query({
  args: { tenantId: v.string(), nonce },
  handler: async ({ db }, { tenantId }) =>
    db
      .query("items")
      .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(20),
});

/** A filter, to check expressions cross the bridge. */
export const openAmountOver = query({
  args: { tenantId: v.string(), min: v.number() },
  handler: async ({ db }, { tenantId, min }) =>
    (
      await db
        .query("items")
        .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId))
        .filter((q) => q.and(q.eq(q.field("status"), "open"), q.gte(q.field("amount"), min)))
        .collect()
    ).length,
});

export const insertItem = mutation({
  args: { tenantId: v.string() },
  handler: async ({ db }, { tenantId }) =>
    db.insert("items", {
      tenantId,
      title: "new item",
      status: "open",
      amount: Math.floor(Math.random() * 10_000),
      createdAt: Date.now(),
    }),
});

export const increment = mutation({
  args: { key: v.string() },
  handler: async ({ db }, { key }) => {
    const row = await db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!row) throw new Error(`counter ${key} not seeded`);
    await db.patch(row._id, { value: (row.value as number) + 1 });
    return null;
  },
});

export const seed = mutation({
  args: { tenants: v.number(), perTenant: v.number(), counters: v.number(), tenantOffset: v.optional(v.number()) },
  handler: async ({ db }, { tenants, perTenant, counters, tenantOffset = 0 }) => {
    const now = Date.now();
    const ids: string[] = [];
    for (let t = tenantOffset; t < tenantOffset + tenants; t++)
      for (let i = 0; i < perTenant; i++)
        ids.push(
          await db.insert("items", {
            tenantId: `t${t}`,
            title: `item ${i} of tenant ${t}`,
            status: i % 3 === 0 ? "done" : "open",
            amount: (i * 7919) % 10_000,
            createdAt: now - i * 1000,
          }),
        );
    for (let i = 0; i < counters; i++) await db.insert("counters", { key: `k${i}`, value: 0 });
    return ids.slice(0, 100);
  },
});

/** Determinism: the same execution sees one time and a seeded `Math.random`. */
export const clock = query(async () => ({
  now: Date.now(),
  // biome-ignore lint/complexity/useDateNow: what is checked is that `new Date()` sees the frozen time too
  same: Date.now() === new Date().getTime(),
  r: Math.random(),
}));

export const nested = query(async (ctx) => ({ inner: await ctx.runQuery("sb:empty" as never, {}) }));

export const readThenWrite = action({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    const n = (await ctx.runQuery("sb:page" as never, { n: 5 } as never)) as number;
    await ctx.runMutation("sb:insertItem" as never, { tenantId } as never);
    return n;
  },
});

export const throws = query(async () => {
  throw new Error("boom from the app");
});

// --- Limits ---

export const spin = query(async () => {
  for (;;) {}
});

export const allocate = query(async () => {
  const keep: number[][] = [];
  for (;;) keep.push(new Array(1 << 20).fill(1));
});

// --- Escape attempts: each reports "blocked: …" or "ESCAPED: …" ---

type Probe = { hostPid: number; hostPort: number; secretFile: string; secretEnv: string };

/** The host's real `process`, through any object the host made (DV-164: `vm` is no boundary). */
// biome-ignore lint/suspicious/noExplicitAny: the probe pokes at whatever the host's process offers
function hostProcess(ctx: object): any {
  return (ctx.constructor.constructor as FunctionConstructor)("return process")();
}

async function attempt(f: () => unknown | Promise<unknown>): Promise<string> {
  try {
    const r = await f();
    return `ESCAPED: ${String(r).slice(0, 80)}`;
  } catch (e) {
    return `blocked: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }
}

export const escapes = action({
  args: { hostPid: v.number(), hostPort: v.number(), secretFile: v.string(), secretEnv: v.string() },
  handler: async (ctx, p: Probe) => {
    const proc = hostProcess(ctx);
    const hostBun = (ctx.constructor.constructor as FunctionConstructor)("return Bun")();
    const req = proc.getBuiltinModule ? (m: string) => proc.getBuiltinModule(m) : (m: string) => require(m);
    const fs = req("node:fs");
    const net = req("node:net");
    return {
      process: await attempt(() => (proc?.versions?.bun ? `process ${proc.pid}` : Promise.reject(new Error("none")))),
      env: await attempt(() => {
        const s = proc.env[p.secretEnv] ?? hostBun.env[p.secretEnv];
        if (!s) throw new Error("not set");
        return s;
      }),
      hostEnviron: await attempt(() => {
        const s = fs.readFileSync(`/proc/${p.hostPid}/environ`);
        if (s.length === 0) throw new Error("empty");
        return `read the host's environ (${s.length} bytes)`;
      }),
      fsRead: await attempt(() => fs.readFileSync(p.secretFile, "utf8")),
      fsWrite: await attempt(() => {
        fs.writeFileSync(`${p.secretFile}.pwned`, "x");
        fs.rmSync(`${p.secretFile}.pwned`);
        return "wrote next to the secret";
      }),
      network: await attempt(
        () =>
          new Promise((resolve, reject) => {
            const s = net.connect({ host: "127.0.0.1", port: p.hostPort });
            s.setTimeout(1000, () => {
              s.destroy();
              reject(new Error("timeout"));
            });
            s.on("connect", () => {
              s.destroy();
              resolve(`connected to 127.0.0.1:${p.hostPort}`);
            });
            s.on("error", reject);
          }),
      ),
      signalHost: await attempt(() => {
        // Signal 0: permission and existence only, nothing is delivered.
        proc.kill(p.hostPid, 0);
        return `could signal pid ${p.hostPid}`;
      }),
      processes: await attempt(() => {
        const pids = fs.readdirSync("/proc").filter((d: string) => /^\d+$/.test(d));
        if (pids.length < 10) throw new Error(`sees only ${pids.length} processes`);
        return `sees ${pids.length} processes`;
      }),
      forkBomb: await attempt(async () => {
        const spawned: { kill: () => void; exited: Promise<number> }[] = [];
        try {
          for (let i = 0; i < 100; i++)
            spawned.push(
              hostBun.spawn([proc.execPath, "-e", "setTimeout(() => {}, 3000)"], {
                stdio: ["ignore", "ignore", "ignore"],
              }),
            );
        } catch (e) {
          if (spawned.length === 0) throw e;
        } finally {
          for (const c of spawned) c.kill();
          await Promise.all(spawned.map((c) => c.exited));
        }
        if (spawned.length < 100) throw new Error(`stopped after ${spawned.length} processes`);
        return `spawned ${spawned.length} processes`;
      }),
    };
  },
});

/**
 * A child that ignores its own `ctx` and writes raw ops to the host: an insert from a query, under every call id it
 * could guess. The host must refuse each by the running call's kind. Returns the host's answers.
 */
export const forgeInsert = query(async () => {
  type Raw = { t?: string; op: number; ok: boolean; error: { message: string } };
  const proc = (globalThis as unknown as { process: NodeJS.Process }).process;
  const answers: string[] = [];
  const onMessage = (m: Raw) => {
    if (m?.t === "result" && m.op >= 1e9) answers.push(m.ok ? "ACCEPTED" : m.error.message);
  };
  proc.on("message", onMessage);
  const doc = { tenantId: "t0", title: "forged", status: "open", amount: 1, createdAt: 1 };
  for (let call = 1; call <= 5000; call++)
    proc.send?.({ t: "op", call, op: 1e9 + call, name: "insert", args: ["items", doc] });
  await new Promise((r) => setTimeout(r, 500));
  proc.off("message", onMessage);
  return answers;
});
