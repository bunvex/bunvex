// Byte streams between host and child (STUDY-171 §12, `streams.ts`): chunk frames carry bytes with no JSON; a sender
// sends no more than its receiver's credit, in chunks of at most 1 MiB; the host refuses a chunk it did not ask for.
import { describe, expect, test } from "bun:test";
import { chunkFrame, FrameReader, frame } from "../src/frames.ts";
import { BadMessageError } from "../src/protocol.ts";
import { CHUNK_BYTES, type StreamMessage, Streams, WINDOW_BYTES } from "../src/streams.ts";

/** Two sides wired to each other, every frame of each recorded. */
function pair(opts: { hostCredit?: number } = {}) {
  const log: string[] = [];
  let host!: Streams;
  let child!: Streams;
  const thrown = (e: unknown) => ({ k: "host" as const, message: String((e as Error).message ?? e) });
  const error = (w: { k: string; message?: string }) => new Error(w.message ?? "failed");
  host = new Streams(
    {
      message: (m: StreamMessage) => {
        log.push(`host ${m.t}`);
        queueMicrotask(() => child.onMessage(m));
      },
      chunk: (s, b) => {
        log.push(`host chunk ${b.byteLength}`);
        const copy = b.slice();
        queueMicrotask(() => child.onChunk(s, copy));
      },
    },
    { strict: true, initialCredit: opts.hostCredit ?? WINDOW_BYTES, thrown, error: error as never },
  );
  child = new Streams(
    {
      message: (m: StreamMessage) => {
        log.push(`child ${m.t}`);
        queueMicrotask(() => {
          try {
            host.onMessage(m);
          } catch (e) {
            log.push(`host refused: ${(e as Error).message}`);
          }
        });
      },
      chunk: (s, b) => {
        log.push(`child chunk ${b.byteLength}`);
        const copy = b.slice();
        queueMicrotask(() => {
          try {
            host.onChunk(s, copy);
          } catch (e) {
            log.push(`host refused: ${(e as Error).message}`);
          }
        });
      },
    },
    { strict: false, initialCredit: 0, thrown, error: error as never },
  );
  return { host, child, log };
}

const pattern = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
};
const collect = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());

describe("frames", () => {
  test("a chunk frame comes out as its stream and bytes, between messages, split at any size", () => {
    const bytes = pattern(1000);
    const stream = new Uint8Array([...frame({ t: "a" }), ...chunkFrame(9, bytes), ...frame({ t: "b" })]);
    for (const size of [1, 3, 7, 100, stream.length]) {
      const reader = new FrameReader(1 << 20);
      const out: unknown[] = [];
      let got: number[] = [];
      for (let i = 0; i < stream.length; i += size)
        for (const f of reader.push(stream.subarray(i, i + size))) {
          if (typeof f !== "string") {
            // A chunk's bytes come as they arrive, in pieces: never joined.
            expect(f.s).toBe(9);
            got.push(...f.bytes);
            continue;
          }
          if (got.length) out.push({ n: got.length, same: got.every((x, j) => x === bytes[j]) });
          got = [];
          out.push(JSON.parse(f));
        }
      expect(out).toEqual([{ t: "a" }, { n: 1000, same: true }, { t: "b" }]);
      expect(reader.pending).toBe(0);
    }
  });

  test("a chunk's piece is a view of what was read, not a copy", () => {
    const framed = chunkFrame(3, pattern(100));
    const pieces = new FrameReader().push(framed).filter((f) => typeof f !== "string");
    expect(pieces).toHaveLength(1);
    expect((pieces[0] as { bytes: Uint8Array }).bytes.buffer).toBe(framed.buffer);
  });

  test("a chunk over the chunk cap is refused from its header", () => {
    expect(() => new FrameReader(1 << 20, 64).push(chunkFrame(1, new Uint8Array(65)).subarray(0, 4))).toThrow(
      "over the limit of 64",
    );
    expect(new FrameReader(1 << 20, 64).push(chunkFrame(1, new Uint8Array(64)))).toHaveLength(1);
  });

  test("a chunk over the cap is refused from its header", () => {
    expect(() => new FrameReader(100).push(chunkFrame(1, new Uint8Array(200)).subarray(0, 4))).toThrow(
      "over the limit",
    );
  });
});

describe("streams", () => {
  test("16 MiB from the host arrive whole, in chunks of at most 1 MiB, as the reader takes them", async () => {
    const { host, child, log } = pair();
    const bytes = pattern(16 * 1024 * 1024 + 123);
    const s = host.sendBytes(bytes);
    const got = await collect(child.receive(s));
    expect(got.length).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(bytes))).toBe(0);
    const chunks = log.filter((l) => l.startsWith("host chunk")).map((l) => Number(l.split(" ")[2]));
    expect(Math.max(...chunks)).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(log).toContain("child credit");
    expect(log.filter((l) => l === "host end")).toHaveLength(1);
  });

  test("a sender stops at its credit until its reader takes what it sent", async () => {
    const { host, child, log } = pair();
    host.sendBytes(pattern(WINDOW_BYTES * 3));
    await Bun.sleep(20);
    // Nobody reads: the window is sent, no more.
    const sent = log.filter((l) => l.startsWith("host chunk")).reduce((n, l) => n + Number(l.split(" ")[2]), 0);
    expect(sent).toBe(WINDOW_BYTES);
    expect(child.sizes.incoming).toBe(1);
  });

  test("the child sends nothing until the host opens its stream", async () => {
    const { host, child, log } = pair();
    const s = child.sendBytes(pattern(5000));
    await Bun.sleep(10);
    expect(log.filter((l) => l.startsWith("child chunk"))).toEqual([]);
    expect((await collect(host.receive(s))).length).toBe(5000);
  });

  test("the host refuses a chunk it never asked for, one past its credit, and an end of no stream", () => {
    const { host } = pair();
    expect(() => host.onChunk(5, new Uint8Array(3))).toThrow(BadMessageError);
    host.receive(6);
    expect(() => host.onChunk(6, new Uint8Array(CHUNK_BYTES + 1))).toThrow(BadMessageError);
    for (let i = 0; i < WINDOW_BYTES / CHUNK_BYTES; i++) host.onChunk(6, new Uint8Array(CHUNK_BYTES));
    expect(() => host.onChunk(6, new Uint8Array(1))).toThrow("past its stream's credit");
    expect(() => host.onMessage({ t: "end", s: 99 })).toThrow(BadMessageError);
    expect(() => host.receive(6)).toThrow(BadMessageError);
  });

  test("a source that fails fails its reader with the sender's error", async () => {
    const { host, child } = pair();
    const s = host.send(
      (async function* () {
        yield new Uint8Array(3);
        throw new Error("the source broke");
      })(),
    );
    await expect(collect(child.receive(s))).rejects.toThrow("the source broke");
  });

  test("a reader that cancels stops its sender", async () => {
    const { host, child, log } = pair();
    let pulled = 0;
    const s = host.send(
      (async function* () {
        for (;;) {
          pulled++;
          yield new Uint8Array(CHUNK_BYTES);
        }
      })(),
    );
    const reader = child.receive(s).getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(20);
    const before = pulled;
    await Bun.sleep(20);
    expect(pulled).toBe(before);
    expect(log).toContain("child stop");
    expect(host.sizes.outgoing).toBe(0);
  });

  test("when the other side is gone, every stream fails", async () => {
    const { host, child } = pair();
    const s = host.sendBytes(pattern(WINDOW_BYTES * 2));
    const r = child.receive(s);
    child.failAll(new Error("the host is gone"));
    await expect(collect(r)).rejects.toThrow("the host is gone");
  });
});
