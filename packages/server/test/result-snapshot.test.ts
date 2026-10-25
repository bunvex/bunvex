// `resultSnapshot` and `snapshotOnSettle` (STUDY-188 §X19 a): a result copied as far as it is plain data, read two
// microtask turns after the handler's promise settles, as Convex's `invokeQuery` serializes it.
import { expect, test } from "bun:test";
import { resultSnapshot, snapshotOnSettle } from "../src/result-snapshot.ts";

test("plain data is copied; anything else is kept as it is, for the checks after", () => {
  class Point {
    x = 1;
  }
  const point = new Point();
  const bytes = new Uint8Array([1, 2]).buffer;
  const value = { a: [1, { b: 2 }], u: undefined, p: point, bytes, n: null, s: new Set([1]) };
  const copy = resultSnapshot(value) as typeof value;
  expect(copy).toEqual(value);
  expect(copy).not.toBe(value);
  expect(copy.a).not.toBe(value.a);
  expect(copy.a[1]).not.toBe(value.a[1]);
  expect("u" in copy).toBe(true);
  expect(copy.p).toBe(point);
  expect(copy.s).toBe(value.s);
  expect(copy.bytes).not.toBe(bytes);
  expect([...new Uint8Array(copy.bytes)]).toEqual([1, 2]);
  // A hole stays a hole (the check after refuses it as before).
  // biome-ignore lint/suspicious/noSparseArray: the case under test
  const holey = resultSnapshot([1, , 3]) as unknown[];
  expect(1 in holey).toBe(false);
  expect(holey.length).toBe(3);
  // A null-prototype object stays one.
  expect(Object.getPrototypeOf(resultSnapshot(Object.create(null)))).toBeNull();
});

test("past the nesting limit the rest is kept as it is: a cycle ends", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let at = resultSnapshot(cycle) as Record<string, unknown>;
  let depth = 0;
  while (at !== cycle) {
    at = at.self as Record<string, unknown>;
    depth++;
  }
  expect(depth).toBeGreaterThan(64);
});

test("read two microtask turns after the promise settles, then never changed", async () => {
  const result: number[] = [];
  const pushAfter = (n: number) => {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => {});
    void p.then(() => result.push(n));
  };
  for (let n = 0; n <= 4; n++) pushAfter(n);
  const snap = snapshotOnSettle(Promise.resolve(result));
  expect(await snap).toEqual([0, 1]);
  await Bun.sleep(0);
  expect(result).toEqual([0, 1, 2, 3, 4]);
  // The same from a value that is not a promise, and a rejection passes through.
  const plain: number[] = [];
  void Promise.resolve().then(() => plain.push(1));
  void Promise.resolve()
    .then(() => {})
    .then(() => {})
    .then(() => plain.push(2));
  expect(await snapshotOnSettle(plain)).toEqual([1]);
  const boom = new Error("boom");
  await expect(snapshotOnSettle(Promise.reject(boom))).rejects.toBe(boom);
});
