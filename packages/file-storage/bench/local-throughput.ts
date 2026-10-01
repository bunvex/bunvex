// The local backend's throughput (STUDY-32): a 256 MiB stream written (hashing, synced) and read back,
// next to Bun writing the same stream to a file without hashing or syncing. MB/s, median of 3.
//   bun packages/file-storage/bench/local-throughput.ts [MiB=256]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBlobStore } from "../src/index.ts";

const MIB = Number(process.argv[2] ?? 256);
const dir = mkdtempSync(join(tmpdir(), "bunvex-bench-"));
const store = new LocalBlobStore(dir);
const chunk = new Uint8Array(1 << 20).map((_, i) => i % 251);
const body = () => {
  let i = 0;
  return new ReadableStream<Uint8Array>({ pull: (c) => (i++ === MIB ? c.close() : c.enqueue(chunk)) });
};
const mbps = (ms: number) => (MIB * 1.048576) / (ms / 1000);
const runs: Record<string, number[]> = {
  "put (hash + sync)": [],
  get: [],
  "Bun.write of the stream (no hash, no sync)": [],
};
for (let r = 0; r < 3; r++) {
  let t = performance.now();
  const w = await store.put(body());
  runs["put (hash + sync)"].push(mbps(performance.now() - t));
  t = performance.now();
  await new Response(await store.get(w.key)).arrayBuffer();
  runs.get.push(mbps(performance.now() - t));
  t = performance.now();
  await Bun.write(join(dir, `copy-${r}`), new Response(body()));
  runs["Bun.write of the stream (no hash, no sync)"].push(mbps(performance.now() - t));
}
for (const [k, xs] of Object.entries(runs)) console.log(`${k}: ${xs.sort((a, b) => a - b)[1].toFixed(0)} MB/s`);
rmSync(dir, { recursive: true, force: true });
