// The checker itself (STUDY-57 §3.4): histories whose answer is known by hand, and a large one built from a
// real sequential execution, which must be found linearizable quickly.
import { describe, expect, test } from "bun:test";
import type { Op } from "../src/history.ts";
import { checkRegisters, isLinearizable, registerModel } from "../src/linearizability.ts";
import { rng } from "../src/rng.ts";

let n = 0;
const op = (
  f: string,
  args: Record<string, unknown>,
  start: number,
  end: number,
  result?: unknown,
  status: Op["status"] = "ok",
): Op => ({
  client: n++ % 3,
  f: `reg:${f}`,
  args: { key: "k", ...args },
  start,
  end: status === "info" ? Infinity : end,
  status,
  result,
});
const lin = (ops: Op[]) => isLinearizable(ops, registerModel);

describe("register linearizability", () => {
  test("a write, then a read of it", () => {
    expect(lin([op("write", { value: 1 }, 0, 10), op("read", {}, 11, 12, 1)])).toBe(true);
  });

  test("a stale read after a later write returned is not linearizable", () => {
    expect(lin([op("write", { value: 1 }, 0, 1), op("write", { value: 2 }, 2, 3), op("read", {}, 4, 5, 1)])).toBe(
      false,
    );
  });

  test("reads during a write may see before, then after — not after, then before", () => {
    const w = op("write", { value: 1 }, 0, 10);
    expect(lin([w, op("read", {}, 1, 2, null), op("read", {}, 3, 4, 1)])).toBe(true);
    expect(lin([w, op("read", {}, 1, 2, 1), op("read", {}, 3, 4, null)])).toBe(false);
  });

  test("a read of a value never written is not linearizable", () => {
    expect(lin([op("write", { value: 1 }, 0, 1), op("read", {}, 2, 3, 7)])).toBe(false);
  });

  test("an unanswered write may have happened, or not", () => {
    const w = op("write", { value: 5 }, 0, 0, undefined, "info");
    expect(lin([w, op("read", {}, 1, 2, 5)])).toBe(true);
    expect(lin([w, op("read", {}, 1, 2, null)])).toBe(true);
  });

  test("compare-and-set: a success needs the expected value; a failure needs another", () => {
    expect(
      lin([op("write", { value: 1 }, 0, 1), op("cas", { from: 1, to: 2 }, 2, 3, true), op("read", {}, 4, 5, 2)]),
    ).toBe(true);
    expect(lin([op("write", { value: 1 }, 0, 1), op("cas", { from: 9, to: 2 }, 2, 3, true)])).toBe(false);
    expect(lin([op("write", { value: 1 }, 0, 1), op("cas", { from: 1, to: 2 }, 2, 3, false)])).toBe(false);
    expect(lin([op("cas", { from: null, to: 3 }, 0, 0, undefined, "info"), op("read", {}, 1, 2, 3)])).toBe(true);
  });

  test("two successful compare-and-sets from the same value cannot both win (a lost update)", () => {
    const ops = [
      op("write", { value: 1 }, 0, 1),
      op("cas", { from: 1, to: 2 }, 2, 5, true),
      op("cas", { from: 1, to: 3 }, 2, 5, true),
    ];
    expect(lin(ops)).toBe(false);
  });

  test("a large history from a real concurrent execution is linearizable, and checked fast", () => {
    // simulate: operations take effect at a random instant inside their window
    const r = rng(42);
    const ops: Op[] = [];
    const effects: { at: number; op: Op }[] = [];
    for (let i = 0; i < 2000; i++) {
      const start = r.next() * 1000;
      const end = start + r.next() * 5;
      const at = start + (end - start) * r.next();
      const kind = r.pick(["read", "write", "cas"] as const);
      const o = op(kind, kind === "write" ? { value: i } : kind === "cas" ? { from: null, to: i } : {}, start, end);
      ops.push(o);
      effects.push({ at, op: o });
    }
    effects.sort((a, b) => a.at - b.at);
    let state: number | null = null;
    for (const { op: o } of effects) {
      const a = o.args as { value?: number; from?: number | null; to?: number };
      if (o.f === "reg:read") o.result = state;
      else if (o.f === "reg:write") state = a.value!;
      else {
        // cas compares against a value seen recently, so some succeed
        a.from = state !== null && r.chance(0.5) ? state : -1;
        o.result = state === a.from;
        if (o.result) state = a.to!;
      }
    }
    const t = performance.now();
    expect(checkRegisters(ops).ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test("a violation is shrunk to the operations that show it", () => {
    const ops = [
      op("write", { value: 1 }, 0, 1),
      op("read", {}, 2, 3, 1),
      op("write", { value: 2 }, 4, 5),
      op("read", {}, 6, 7, 2),
      op("read", {}, 8, 9, 1),
    ];
    const res = checkRegisters(ops);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.minimal.length).toBeLessThanOrEqual(3);
  });

  test("shrinking never drops a write that explains another operation (it would invent a violation)", () => {
    const explains = op("write", { value: 2 }, 2, 3);
    const stale = op("read", {}, 6, 7, 1); // the real violation: a stale read after the write of 2
    const ops = [
      op("write", { value: 1 }, 0, 1),
      explains,
      op("cas", { from: 1, to: 5 }, 4, 5, false), // right: the value is 2 by then
      stale,
    ];
    const res = checkRegisters(ops);
    expect(res.ok).toBe(false);
    // without the write of 2, the failed compare-and-set would look wrong: a false witness
    if (!res.ok) expect(res.minimal).toEqual(expect.arrayContaining([explains, stale]));
  });
});
