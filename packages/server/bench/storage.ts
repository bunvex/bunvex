// File storage over HTTP (STUDY-32): upload and download throughput on the local backend, next to the
// backend's own put/get (no HTTP). MB/s, median of 3.
//   bun packages/server/bench/storage.ts [MiB=64]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { LocalBlobStore } from "@bunvex/file-storage";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const MIB = Number(process.argv[2] ?? 64);
const dir = mkdtempSync(join(tmpdir(), "bunvex-storage-bench-"));
const blobs = new LocalBlobStore(dir);
const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
const functions = new Functions(engine).register("m", {
  uploadUrl: mutation(async ({ storage }) => storage.generateUploadUrl()),
  url: query(async ({ storage }, { id }: { id: string }) => storage.getUrl(id)),
});
const server = createServer({ engine, functions, port: 0, fileStorage: blobs });
const data = new Uint8Array(MIB << 20).map((_, i) => i % 251);
const mbps = (ms: number) => (MIB * 1.048576) / (ms / 1000);
const runs: Record<string, number[]> = {
  "HTTP upload": [],
  "HTTP download": [],
  "backend put (no HTTP)": [],
  "backend get (no HTTP)": [],
};
for (let r = 0; r < 3; r++) {
  let t = performance.now();
  const up = await fetch((await functions.runMutation("m:uploadUrl", {})) as string, { method: "POST", body: data });
  const { storageId } = (await up.json()) as { storageId: string };
  runs["HTTP upload"].push(mbps(performance.now() - t));
  const url = (await functions.runQuery("m:url", { id: storageId })) as string;
  t = performance.now();
  await (await fetch(url)).arrayBuffer();
  runs["HTTP download"].push(mbps(performance.now() - t));
  t = performance.now();
  const w = await blobs.put(data);
  runs["backend put (no HTTP)"].push(mbps(performance.now() - t));
  t = performance.now();
  await new Response(await blobs.get(w.key)).arrayBuffer();
  runs["backend get (no HTTP)"].push(mbps(performance.now() - t));
}
for (const [k, xs] of Object.entries(runs)) console.log(`${k}: ${xs.sort((a, b) => a - b)[1].toFixed(0)} MB/s`);
server.stop();
await engine.close();
rmSync(dir, { recursive: true, force: true });
