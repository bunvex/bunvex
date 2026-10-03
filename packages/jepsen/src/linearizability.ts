// A linearizability checker for the register workload (STUDY-57 §3.4), written from the papers:
//   - Wing & Gong, "Testing and verifying concurrent objects" (J. Parallel Distrib. Comput., 1993): search
//     for a sequential order of the operations that respects real time (an operation that returned before
//     another was invoked comes first) and the object's sequential specification;
//   - Lowe, "Testing for linearizability" (Concurrency Computat.: Pract. Exper., 2017): memoise the
//     (set of linearized operations, state) pairs already explored, which makes the search practical;
//   - Herlihy & Wing, "Linearizability: a correctness condition for concurrent objects" (TOPLAS, 1990):
//     linearizability is local, so each key is checked on its own (partitioning).
// An "info" operation (no answer) may take effect at any point after its invocation, or never; it is placed
// with an infinite return time, so it may be linearized last, which for a register is the same as never.
import type { Op } from "./history.ts";

/** A sequential specification: the states an operation may move `state` to (none: not allowed there). */
export type Model<S> = {
  init: S;
  step: (state: S, op: Op) => S[];
  key: (state: S) => string;
};

/** A register holding `null` until written: read, write and compare-and-set. */
export const registerModel: Model<number | null> = {
  init: null,
  key: (s) => String(s),
  step(s, op) {
    const a = op.args as { value?: number; from?: number | null; to?: number };
    switch (op.f) {
      case "reg:read":
        return op.result === s ? [s] : [];
      case "reg:write":
        return [a.value ?? null];
      case "reg:cas":
        if (op.status === "info") return s === a.from ? [a.to ?? null] : [s];
        if (op.result === true) return s === a.from ? [a.to ?? null] : [];
        return s !== a.from ? [s] : [];
      default:
        throw new Error(`registerModel: unexpected ${op.f}`);
    }
  },
};

type Entry = {
  op: Op;
  index: number;
  call: boolean;
  time: number;
  match: Entry | null;
  prev: Entry | null;
  next: Entry | null;
};

/** Whether `ops` (one object's operations) have a linearization under `model`. */
export function isLinearizable<S>(ops: readonly Op[], model: Model<S>): boolean {
  // the entries in time order; at equal times, returns before calls (the operations did not overlap)
  const events: Entry[] = [];
  ops.forEach((op, index) => {
    const call: Entry = { op, index, call: true, time: op.start, match: null, prev: null, next: null };
    const ret: Entry = { op, index, call: false, time: op.end, match: call, prev: null, next: null };
    call.match = ret;
    events.push(call, ret);
  });
  events.sort((x, y) => x.time - y.time || Number(x.call) - Number(y.call));
  const head: Entry = {
    op: null as never,
    index: -1,
    call: false,
    time: -Infinity,
    match: null,
    prev: null,
    next: null,
  };
  let last = head;
  for (const e of events) {
    e.prev = last;
    last.next = e;
    last = e;
  }
  const lift = (e: Entry) => {
    e.prev!.next = e.next;
    if (e.next) e.next.prev = e.prev;
    const r = e.match!;
    r.prev!.next = r.next;
    if (r.next) r.next.prev = r.prev;
  };
  const unlift = (e: Entry) => {
    const r = e.match!;
    r.prev!.next = r;
    if (r.next) r.next.prev = r;
    e.prev!.next = e;
    if (e.next) e.next.prev = e;
  };

  const done = new Uint8Array(ops.length);
  const doneKey = () => {
    let s = "";
    for (let i = 0; i < done.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < done.length; j++) b |= done[i + j]! << j;
      s += String.fromCharCode(b);
    }
    return s;
  };
  const seen = new Set<string>();
  // the search, as an explicit stack: each frame remembers what it undoes and which states it has left to try
  type Frame = { entry: Entry; before: S; rest: S[] };
  const stack: Frame[] = [];
  let state = model.init;
  let entry = head.next;
  while (head.next) {
    if (!entry) return false;
    if (entry.call) {
      const options = model.step(state, entry.op);
      let advanced = false;
      while (options.length) {
        const next = options.shift()!;
        done[entry.index] = 1;
        const k = `${doneKey()}|${model.key(next)}`;
        if (!seen.has(k)) {
          seen.add(k);
          stack.push({ entry, before: state, rest: options });
          state = next;
          lift(entry);
          entry = head.next;
          advanced = true;
          break;
        }
        done[entry.index] = 0;
      }
      if (!advanced) entry = entry.next;
    } else {
      // a return: its operation must already be linearized; backtrack
      for (;;) {
        const top = stack.pop();
        if (!top) return false;
        state = top.before;
        done[top.entry.index] = 0;
        unlift(top.entry);
        // another state for the same operation, if its specification allowed several
        const next = top.rest.shift();
        if (next !== undefined) {
          done[top.entry.index] = 1;
          const k = `${doneKey()}|${model.key(next)}`;
          if (!seen.has(k)) {
            seen.add(k);
            stack.push({ entry: top.entry, before: state, rest: top.rest });
            state = next;
            lift(top.entry);
            entry = head.next;
            break;
          }
          done[top.entry.index] = 0;
        }
        entry = top.entry.next;
        break;
      }
    }
  }
  return true;
}

export type LinearizabilityResult = { ok: true; keys: number } | { ok: false; key: string; ops: Op[]; minimal: Op[] };

/** The register operations of a history, per key; failed operations and unanswered reads say nothing. */
export function registerPartitions(ops: readonly Op[]): Map<string, Op[]> {
  const byKey = new Map<string, Op[]>();
  for (const op of ops) {
    if (!op.f.startsWith("reg:")) continue;
    if (op.status === "fail") continue;
    if (op.f === "reg:read" && op.status !== "ok") continue;
    const key = String((op.args as { key: string }).key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(op);
  }
  return byKey;
}

/** Check every key; on a violation, shrink that key's operations to a small history that still fails. */
export function checkRegisters(ops: readonly Op[]): LinearizabilityResult {
  const parts = registerPartitions(ops);
  for (const [key, keyOps] of parts) {
    if (!isLinearizable(keyOps, registerModel)) return { ok: false, key, ops: keyOps, minimal: shrink(keyOps) };
  }
  return { ok: true, keys: parts.size };
}

/**
 * Shrink a non-linearizable history to a small one that still fails, delta-debugging style (Zeller &
 * Hildebrandt, "Simplifying and isolating failure-inducing input", TSE 2002): try dropping chunks, halving the
 * chunk size down to single operations; stop after `budgetMs`.
 */
export function shrink(ops: Op[], budgetMs = 3000): Op[] {
  const t = performance.now();
  let current = ops.slice();
  for (let size = Math.max(1, Math.floor(current.length / 2)); size >= 1; size = Math.floor(size / 2)) {
    for (let i = 0; i < current.length && performance.now() - t < budgetMs; ) {
      const without = current.slice(0, i).concat(current.slice(i + size));
      if (without.length && wellFormed(without) && !isLinearizable(without, registerModel)) current = without;
      else i += size;
    }
    if (size === 1 || performance.now() - t >= budgetMs) break;
  }
  return current;
}

/**
 * A shrunk history must still explain its reads: every value read (or expected by a compare-and-set) is
 * written by an operation in it. Otherwise dropping the writes would "shrink" any history to one bare read.
 */
function wellFormed(ops: readonly Op[]): boolean {
  const written = new Set<unknown>([null]);
  for (const op of ops) {
    const a = op.args as { value?: number; to?: number };
    if (op.f === "reg:write") written.add(a.value);
    if (op.f === "reg:cas") written.add(a.to);
  }
  return ops.every((op) => {
    if (op.f === "reg:read") return written.has(op.result);
    if (op.f === "reg:cas" && op.result === true) return written.has((op.args as { from?: unknown }).from);
    return true;
  });
}
