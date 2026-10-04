// A file download's egress is the bytes actually sent (STUDY-65 M3, DV-309), as Convex's `get_file` /
// `get_file_range` (crates/application/src/lib.rs, `track_storage_egress` per chunk, `add_on_complete`): the
// usage meter's `dataEgressGb` grows as chunks go out, and once the download ends — read to its end, cut by the
// client, or a range — one `storage_api_bandwidth` event carries the file's id and those bytes (Convex's
// `test_storage_api_bandwidth_log_events`).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { type BlobStore, MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { createServer } from "../src/server.ts";

const CHUNK = 64 * 1024;
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A memory store that hands a blob out in 64 KiB chunks, each made when it is read, a millisecond apart. */
function chunkedStore(): BlobStore {
  const inner = new MemoryBlobStore();
  return {
    put: (b) => inner.put(b),
    delete: (k) => inner.delete(k),
    list: () => inner.list(),
    async get(key, range) {
      const s = await inner.get(key, range);
      if (!s) return null;
      const bytes = new Uint8Array(await new Response(s).arrayBuffer());
      let at = 0;
      return new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            await Bun.sleep(1); // a read is pending at times, as from a disk or a bucket
            if (at >= bytes.length) return c.close();
            c.enqueue(bytes.slice(at, at + CHUNK));
            at += CHUNK;
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}

async function setup(store: BlobStore = chunkedStore()) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    uploadUrl: mutation(({ storage }) => storage.generateUploadUrl()),
    urlOf: query(({ storage }, { id }: { id: string }) => storage.getUrl(id as never)),
  });
  const s = createServer({ engine, functions, port: 0, fileStorage: store });
  stops.push(() => s.stop());
  const events: Record<string, unknown>[] = [];
  const send = s.logManager.send.bind(s.logManager);
  s.logManager.send = (e: LogEvent[]) => {
    for (const x of e) if (x.event.topic === "storage_api_bandwidth") events.push(eventJsonV2(x));
    send(e);
  };
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const call = async (kind: string, path: string, args: object = {}) =>
    (
      (await (
        await fetch(`${api}/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args }),
        })
      ).json()) as { value: unknown }
    ).value;
  /** Upload `size` bytes: the file's id and URL. */
  const upload = async (size: number) => {
    const url = (await call("mutation", "m:uploadUrl")) as string;
    const r = await fetch(url, { method: "POST", body: new Uint8Array(size).fill(7) });
    const { storageId } = (await r.json()) as { storageId: string };
    return { storageId, url: (await call("query", "m:urlOf", { id: storageId })) as string };
  };
  const egress = () => s.usageMeter.usage("dataEgressGb", "day");
  const until = async <T>(f: () => T | undefined) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x !== undefined) return x;
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  return { events, upload, egress, until };
}

test("a full read: one event with the file's id and its bytes; the same bytes metered", async () => {
  const t = await setup();
  const f = await t.upload(300_000);
  expect((await (await fetch(f.url)).arrayBuffer()).byteLength).toBe(300_000);
  const e = await t.until(() => t.events[0]);
  expect(e).toEqual({
    timestamp: expect.any(Number),
    topic: "storage_api_bandwidth",
    storage_id: f.storageId,
    egress_bytes: 300_000,
  });
  expect(t.egress()).toBe(300_000);
  await Bun.sleep(20);
  expect(t.events.length).toBe(1);
});

test("a client that leaves mid-download: what was sent, not the file's size", async () => {
  const t = await setup();
  const size = 8 * 1024 * 1024;
  const f = await t.upload(size);
  const aborted = new AbortController();
  const r = await fetch(f.url, { signal: aborted.signal });
  await r.body!.getReader().read();
  aborted.abort();
  const e = await t.until(() => t.events[0]);
  const sent = e.egress_bytes as number;
  expect(sent).toBeGreaterThan(0);
  expect(sent).toBeLessThan(size);
  expect(e.storage_id).toBe(f.storageId);
  // A chunk still being read when the client left is neither sent nor metered.
  await Bun.sleep(50);
  expect(t.egress()).toBe(sent);
  expect(t.events.length).toBe(1);
});

test("a range: the range's bytes", async () => {
  const t = await setup();
  const f = await t.upload(4096);
  const r = await fetch(f.url, { headers: { range: "bytes=0-1023" } });
  expect(r.status).toBe(206);
  expect((await r.arrayBuffer()).byteLength).toBe(1024);
  const e = await t.until(() => t.events[0]);
  expect(e.egress_bytes).toBe(1024);
  expect(t.egress()).toBe(1024);
});

test("a HEAD request: an event with 0 bytes, nothing metered, the length header kept", async () => {
  // The memory store's blob-backed stream: Bun sends its length (a stream it cannot size it sends chunked).
  const t = await setup(new MemoryBlobStore());
  const f = await t.upload(1000);
  const r = await fetch(f.url, { method: "HEAD" });
  expect(r.headers.get("content-length")).toBe("1000");
  const e = await t.until(() => t.events[0]);
  expect([e.storage_id, e.egress_bytes]).toEqual([f.storageId, 0]);
  expect(t.egress()).toBe(0);
});

// DV-324 pin: Bun 1.4.2 drops `content-length` from a wrapped (metered) stream, which Convex sends. When this
// fails, Bun keeps it: remove the divergence from DV-324 and assert the header here instead.
test("DV-324: a metered GET or Range download has no content-length (Bun drops it from a wrapped stream)", async () => {
  const t = await setup(new MemoryBlobStore());
  const f = await t.upload(300_000);
  const full = await fetch(f.url);
  const range = await fetch(f.url, { headers: { range: "bytes=0-99999" } });
  expect([full.headers.get("content-length"), range.headers.get("content-length")]).toEqual([null, null]);
  expect([(await full.arrayBuffer()).byteLength, (await range.arrayBuffer()).byteLength]).toEqual([300_000, 100_000]);
});
