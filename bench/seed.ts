// Seed over HTTP with the same volume as convex-bench's load/ws/seed.mjs: 1000 tenants x 100 items +
// 1000 counters, in mutations of 2000 documents.
const BASE = process.env.BENCH_URL ?? "http://127.0.0.1:3210";
const call = async (path: string, args: unknown) => {
  const r = await fetch(`${BASE}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  const j = (await r.json()) as { status: string; errorMessage?: string };
  if (j.status !== "success") throw new Error(`${path}: ${j.errorMessage}`);
};
const t0 = Date.now();
const batches = Array.from({ length: 50 }, (_, i) => ({ tenantOffset: i * 20, tenants: 20, perTenant: 100 }));
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (batches.length) await call("bench:seedItems", batches.shift());
  }),
);
await call("bench:seedCounters", { n: 1000 });
console.log(`seed ok: 100000 items, 1000 counters in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

export {};
