// Search index snapshot measurements (STUDY-96): how long a restart takes until the text and vector indexes
// are ready, restored from the snapshot (plus the log since) vs indexed from the table, and the snapshot's
// size and write time at shutdown.
//   bun bench/search-snapshot.ts <sqlite path> <documents> [changes since the snapshot]
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, defineTable, Engine, type SearchSnapshotStore } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const [where, n = "50000", since = "0"] = process.argv.slice(2);
if (!where) throw new Error("usage: bun bench/search-snapshot.ts <sqlite path> <documents> [changes since]");
const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 64 }),
});
const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho".split(" ");
const note = (i: number) => ({
  body: `${Array.from({ length: 12 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ")} n${i}`,
  kind: `k${i % 10}`,
  v: Array.from({ length: 64 }, (_, k) => Math.sin(i + k)),
});

/** Blobs as files, as the server's local `search` use case keeps them. */
const dir = `${where}.search`;
const files: SearchSnapshotStore = {
  put: async (d) => {
    const key = crypto.randomUUID();
    await Bun.write(join(dir, key), d);
    return key;
  },
  get: async (k) => {
    const f = Bun.file(join(dir, k));
    return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
  },
  delete: async (k) => rmSync(join(dir, k), { force: true }),
};

async function open(snapshots?: SearchSnapshotStore) {
  const t = performance.now();
  const e = await new Engine(
    schema,
    new SqlitePersistence(where!, { durable: true }),
    snapshots ? { searchSnapshots: snapshots } : {},
  ).init();
  await e.searchReady();
  return { e, ms: Math.round(performance.now() - t) };
}

rmSync(where, { force: true });
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
{
  const { e } = await open(files);
  for (let i = 0; i < Number(n); i += 500)
    await e.mutation(async (db) => {
      for (let k = i; k < Math.min(i + 500, Number(n)); k++) await db.insert("notes", note(k));
    });
  const t = performance.now();
  await e.close();
  const size = readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
  console.log(
    `${n} documents; close with the snapshot: ${Math.round(performance.now() - t)} ms, ${(size / 2 ** 20).toFixed(1)} MiB`,
  );
}
if (Number(since)) {
  // A run with no snapshot store (as a crash leaves it): its writes are the log since the snapshot.
  const { e } = await open();
  for (let i = 0; i < Number(since); i += 500)
    await e.mutation(async (db) => {
      for (let k = i; k < Math.min(i + 500, Number(since)); k++) await db.insert("notes", note(Number(n) + k));
    });
  await e.close();
}
// Each restored run's close writes a new snapshot: only the first restores with changes since.
for (let round = 0; round < 3; round++) {
  const scan = await open();
  await scan.e.close();
  const restored = await open(files);
  const r = restored.e.searchStats.restored;
  await restored.e.close();
  console.log(
    `indexed from the table: ${scan.ms} ms; restored (${r} indexes, ${round ? 0 : since} changes since): ${restored.ms} ms`,
  );
}
