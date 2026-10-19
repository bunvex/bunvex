// STUDY-168 prototype: what host and sandbox send each other over Bun's IPC channel (JSON serialization: the host
// parses what the untrusted child writes with `JSON.parse` only, a small and well-tested surface, not a structured
// clone deserializer).
//
// Values are encoded so JSON carries every bunvex value: an int64 as `{"$integer": "<decimal>"}`, bytes as
// `{"$bytes": "<base64>"}` (the shape of the value JSON format), and a query builder's recorded expression
// (an index range or a filter, see `recorder` below) as `{"$chain": [[method, args], …]}`. A prototype: a document
// whose own field is named `$integer`, `$bytes` or `$chain` would be misread.

export type Wire = null | boolean | number | string | Wire[] | { [k: string]: Wire };

/** host → child */
export type ToChild =
  | {
      t: "call";
      call: number;
      fn: string;
      kind: "query" | "mutation" | "action";
      args: Wire;
      /** The execution's seed and frozen time, drawn from the host's deterministic globals (queries, mutations). */
      seed: number;
      now: number;
      env: Record<string, string>;
    }
  | { t: "result"; call: number; op: number; ok: true; value: Wire }
  | { t: "result"; call: number; op: number; ok: false; error: WireError }
  /** batchOps: the answers of one tick. */
  | { t: "results"; list: ToChild[] };

/** child → host */
export type ToHost =
  | { t: "ready"; functions: Record<string, "query" | "mutation" | "action">; loadMs: number }
  // `ran`: how long the call's own JS ran since its last op was answered (or since it started), in ms, by the child's
  // clock: the user time the host charges ("child" accounting).
  | { t: "op"; call: number; op: number; name: string; args: Wire[]; ran?: number }
  | { t: "done"; call: number; ok: true; value: Wire; ran?: number }
  | { t: "done"; call: number; ok: false; error: WireError; ran?: number }
  /** batchOps: the ops of one tick. */
  | { t: "ops"; list: ToHost[] }
  | { t: "log"; call: number; level: string; text: string };

export type WireError = { name: string; message: string; data?: Wire; stack?: string };

export const CHAIN = "$chain";

export function encode(v: unknown): Wire {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return { $integer: v.toString() };
  if (v instanceof ArrayBuffer) return { $bytes: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v)) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === "object") {
    const chain = (v as { [RECORDED]?: Step[] })[RECORDED];
    if (chain) return { [CHAIN]: chain };
    const out: Record<string, Wire> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x);
    return out;
  }
  if (typeof v === "function") {
    const chain = (v as unknown as { [RECORDED]?: Step[] })[RECORDED];
    if (chain) return { [CHAIN]: chain };
  }
  if (v === undefined) return null;
  throw new Error(`${typeof v} is not a supported value type`);
}

/** Decodes a value; `chain` replays a recorded expression (the host passes its real builder there). */
export function decode(w: Wire, chain?: (steps: Step[]) => unknown): unknown {
  if (w === null || typeof w !== "object") return w;
  if (Array.isArray(w)) return w.map((x) => decode(x, chain));
  const keys = Object.keys(w);
  if (keys.length === 1) {
    if (keys[0] === "$integer") return BigInt(w.$integer as string);
    if (keys[0] === "$bytes") {
      const b = Buffer.from(w.$bytes as string, "base64");
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    if (keys[0] === CHAIN) {
      if (!chain) throw new Error("unexpected expression");
      return chain(w[CHAIN] as unknown as Step[]);
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decode(w[k] as Wire, chain);
  return out;
}

/** One recorded call on a query builder: `["eq", [field, value]]`. */
export type Step = [string, Wire[]];
export const RECORDED = Symbol("recorded");

/**
 * A stand-in for an index range or filter builder (`q` in `withIndex(name, (q) => q.eq(…))`): every method call
 * returns another stand-in that remembers the chain, so the host can replay it on its real builder.
 */
export function recorder(steps: Step[] = []): unknown {
  const target = () => {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === RECORDED) return steps;
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return (...args: unknown[]) => recorder([...steps, [prop, args.map(encode)]]);
    },
  });
}

/** Replays recorded steps on a real builder, nested expressions from the same root. */
export function replay(root: unknown, steps: Step[]): unknown {
  let cur = root as Record<string, (...a: unknown[]) => unknown>;
  for (const [method, args] of steps) {
    const fn = cur[method];
    if (typeof fn !== "function") throw new Error(`${method} is not a function`);
    cur = fn.apply(
      cur,
      args.map((a) => decode(a, (s) => replay(root, s))),
    ) as typeof cur;
  }
  return cur;
}
