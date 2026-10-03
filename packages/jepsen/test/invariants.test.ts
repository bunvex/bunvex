import { describe, expect, test } from "bun:test";
import type { Op } from "../src/history.ts";
import { checkBank, checkLog, checkSet } from "../src/invariants.ts";

const op = (f: string, args: Record<string, unknown>, status: Op["status"] = "ok", result?: unknown): Op => ({
  client: 0,
  f,
  args,
  start: 0,
  end: status === "info" ? Infinity : 1,
  status,
  result,
});

describe("invariants", () => {
  test("bank: every read and the end sum to the total, none negative", () => {
    expect(checkBank([op("bank:all", {}, "ok", { a: 60, b: 40 })], 100, { a: 50, b: 50 })).toEqual([]);
    expect(checkBank([op("bank:all", {}, "ok", { a: 70, b: 40 })], 100, { a: 50, b: 50 }).length).toBe(1);
    expect(checkBank([], 100, { a: 110, b: -10 }).length).toBeGreaterThan(0);
  });

  test("set: acknowledged adds are there once; failed ones are not; unanswered ones may be", () => {
    const ops = [
      op("set:add", { token: "a" }),
      op("set:add", { token: "b" }, "info"),
      op("set:add", { token: "c" }, "fail"),
    ];
    expect(checkSet(ops, ["a"])).toEqual([]);
    expect(checkSet(ops, ["a", "b"])).toEqual([]);
    expect(checkSet(ops, [])).toEqual(["set: a was acknowledged but is lost"]);
    expect(checkSet(ops, ["a", "a"])).toEqual(["set: a is present 2 times (a mutation ran more than once)"]);
    expect(checkSet(ops, ["a", "c"])).toEqual(["set: c is present, but its add was reported failed"]);
    expect(checkSet(ops, ["a", "z"])).toEqual(["set: z is present but was never added"]);
  });

  test("log: per client in order, once; acknowledged ones there, failed ones not", () => {
    const ops = [0, 1, 2].map((seq) => op("log:append", { client: 7, seq }, seq === 2 ? "fail" : "ok"));
    expect(
      checkLog(ops, [
        [7, 0],
        [7, 1],
      ]),
    ).toEqual([]);
    expect(
      checkLog(ops, [
        [7, 1],
        [7, 0],
      ]),
    ).toEqual(["log: client 7's mutation 0 committed after its mutation 1"]);
    expect(
      checkLog(ops, [
        [7, 0],
        [7, 0],
        [7, 1],
      ]),
    ).toEqual(["log: client 7's mutation 0 committed twice"]);
    expect(checkLog(ops, [[7, 0]])).toEqual(["log: client 7's mutation 1 was acknowledged but is lost"]);
    expect(
      checkLog(ops, [
        [7, 0],
        [7, 1],
        [7, 2],
      ]),
    ).toEqual(["log: client 7's mutation 2 is present, but it was reported failed"]);
  });
});
