// A write that fails cancels the body it was reading (STUDY-174 S3, I-28): the body's source learns that nothing
// reads it any more, as a Rust stream dropped with its failed upload does in Convex. An import's file, streamed from
// its zip entry, then closes the entry's stream at once instead of leaving it suspended until it is collected.
import { expect, test } from "bun:test";
import { pumpHashing } from "../src/store.ts";

function source() {
  const seen = { pulled: 0, cancelled: null as unknown };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      seen.pulled++;
      c.enqueue(new Uint8Array(16));
    },
    cancel(reason) {
      seen.cancelled = reason;
    },
  });
  return { body, seen };
}

test("a write that throws cancels the body with its error", async () => {
  const { body, seen } = source();
  const failure = new Error("no space left on device");
  let writes = 0;
  await expect(
    pumpHashing(body, () => {
      if (++writes === 3) throw failure;
    }),
  ).rejects.toBe(failure);
  expect(seen.cancelled).toBe(failure);
});

test("an async generator behind the body runs its cleanup when the write fails", async () => {
  let cleaned = false;
  async function* chunks() {
    try {
      for (;;) yield new Uint8Array(16);
    } finally {
      cleaned = true;
    }
  }
  const it = chunks();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await it.next();
      if (done) c.close();
      else c.enqueue(value);
    },
    async cancel() {
      await it.return(undefined);
    },
  });
  await expect(
    pumpHashing(body, () => {
      throw new Error("write failed");
    }),
  ).rejects.toThrow("write failed");
  expect(cleaned).toBe(true);
});

test("a body that ends is hashed whole and never cancelled", async () => {
  const seen = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("hello "));
      c.enqueue(new TextEncoder().encode("world"));
      c.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  const out: number[] = [];
  const { size, sha256 } = await pumpHashing(body, (c) => void out.push(c.byteLength));
  expect(size).toBe(11);
  expect(Buffer.from(sha256).toString("hex")).toBe(new Bun.CryptoHasher("sha256").update("hello world").digest("hex"));
  expect(out).toEqual([6, 5]);
  expect(seen.cancelled).toBe(false);
});

test("a source whose cancel never settles does not hold the failed write's error back", async () => {
  // Its cancel waits on a read that never ends (a stalled range read behind an async generator, say).
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(16));
    },
    cancel: () => new Promise<void>(() => {}),
  });
  const failure = new Error("write failed");
  const outcome = await Promise.race([
    pumpHashing(body, () => {
      throw failure;
    }).catch((e) => e),
    Bun.sleep(1000).then(() => "still waiting after 1 s"),
  ]);
  expect(outcome).toBe(failure);
});
