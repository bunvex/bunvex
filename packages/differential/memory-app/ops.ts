// Functions that hold more memory than a function may (STUDY-188 §X17, R12): Convex caps each function's isolate at
// 64 MiB of heap and 64 MiB of array buffers and fails it, uncatchably, with "JavaScript execution ran out of memory
// (maximum memory usage: 64 MB)". Each allocation sits in a `try`/`catch` that would answer "caught": the cap must not
// be catchable. `under` holds less than the cap and returns; `churn` allocates far more than the cap, as garbage. A
// buffer is held across an operation (`op`): on Convex its allocation fails; under bunvex's `process` executor the child
// measures it at its next message, and one dropped before then may be collected first (STUDY-188 §X17b, G1).
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const MiB = 1024 * 1024;

/** What each probe allocates, kept reachable until it returns; `op` is an operation of the function's `ctx`. */
const probes: Record<string, (op: () => Promise<unknown>) => unknown> = {
  /** A 512 MiB `ArrayBuffer`, never written, held across an operation. */
  arrayBuffer: async (op) => {
    const buffer = new ArrayBuffer(512 * MiB);
    await op();
    return buffer.byteLength;
  },
  /** A 4 GiB one. */
  arrayBuffer4g: async (op) => {
    const buffer = new ArrayBuffer(4 * 1024 * MiB);
    await op();
    return buffer.byteLength;
  },
  /** A 512 MiB `Blob` (its bytes, then the blob's copy). */
  blob: () => new Blob([new Uint8Array(512 * MiB)]).size,
  /** 1 MiB typed arrays, written, kept until 512 MiB. */
  typedArrays: () => {
    const kept: Uint8Array[] = [];
    for (let i = 0; i < 512; i++) kept.push(new Uint8Array(MiB).fill(i));
    return kept.length;
  },
  /** Objects, kept, until 2^23 of them (several hundred MiB). */
  objects: () => {
    const kept: { i: number; s: string }[] = [];
    for (let i = 0; i < 1 << 23; i++) kept.push({ i, s: `row ${i}` });
    return kept.length;
  },
  /** Distinct flat 1 MiB strings (decoded from bytes, not ropes), kept, until 512 of them. */
  strings: () => {
    const kept: string[] = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < 512; i++) kept.push(decoder.decode(new Uint8Array(MiB).fill(97 + (i % 26))));
    return kept.length;
  },
  /** Under the cap: 16 MiB of array buffers, 16 MiB of strings and 100 000 objects. */
  under: () => {
    const bytes = new Uint8Array(16 * MiB).fill(1);
    const text = "x".repeat(16 * MiB);
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ i }));
    return bytes.length + text.length + rows.length;
  },
  /** Garbage, never more than a few MiB of it live: 1 GiB allocated in all, 1 MiB at a time. */
  churn: () => {
    let n = 0;
    for (let i = 0; i < 1024; i++) n += new Uint8Array(MiB).fill(1)[i % MiB]!;
    for (let i = 0; i < 512; i++) n += JSON.parse(JSON.stringify({ s: "y".repeat(MiB) })).s.length > 0 ? 1 : 0;
    return n;
  },
};

const run = async (probe: string, op: () => Promise<unknown>) => {
  console.log(`allocating ${probe}`);
  try {
    return { value: await probes[probe]!(op) };
  } catch (e) {
    return { caught: `${(e as Error).name}: ${(e as Error).message}` };
  }
};

export const query = queryGeneric({
  args: { probe: v.string() },
  handler: async (ctx, { probe }) => run(probe, () => ctx.db.query("rows").first()),
});
export const mutation = mutationGeneric({
  args: { probe: v.string() },
  handler: async (ctx, { probe }) => run(probe, () => ctx.db.query("rows").first()),
});
export const action = actionGeneric({
  args: { probe: v.string() },
  handler: async (ctx, { probe }) => run(probe, () => ctx.runQuery("ops:ping" as never)),
});

/** A function that holds nothing much: the next call after one that failed. */
export const ping = queryGeneric({ args: {}, handler: async () => "pong" });
