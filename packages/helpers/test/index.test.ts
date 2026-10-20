// convex-helpers' `index.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 1), with tests of the utilities it does
// not cover: `asyncMap` (in parallel, in order), `pruneNull`, `nullThrows` and `assert`. The type assertions
// (vitest's `expectTypeOf`) are `Equals` checks, which `tsc` runs (`bun run typecheck`).
// biome-ignore-all lint/suspicious/noExplicitAny: the ported tests use `any` as convex-helpers' do
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import {
  assert,
  asyncMap,
  type EmptyObject,
  type Equals,
  type ErrorMessage,
  NullDocumentError,
  nullThrows,
  omit,
  pick,
  pruneNull,
  withoutSystemFields,
} from "../src/index.ts";

/** A type assertion: compiles only when `T` is `true`. */
const check = <T extends true>(_?: T) => {};

test("pick", () => {
  const obj = { a: "a", b: "b", c: "c" };
  const picked = pick(obj, ["a", "b"]);
  expect(picked).toEqual({ a: "a", b: "b" });
  expect(pick(obj, [])).toEqual({});
  expect(pick(obj, ["a", "b", "c"])).toEqual({ a: "a", b: "b", c: "c" });
  expect(pick(obj, ["a", "b", "c", "d" as any])).toEqual({ a: "a", b: "b", c: "c" });

  check<Equals<typeof picked, { a: string; b: string }>>();
});

test("omit", () => {
  const obj = { a: "a", b: "b", c: "c" };
  const omitted = omit(obj, ["a", "b"]);
  expect(omitted).toEqual({ c: "c" });
  expect(omit(obj, [])).toEqual({ a: "a", b: "b", c: "c" });
  expect(omit(obj, ["a", "b", "c", "d" as any])).toEqual({});

  check<Equals<typeof omitted, { c: string }>>();
});

test("withoutSystemFields", () => {
  const obj = { _id: "1", _creationTime: 1, a: "a" };
  const without = withoutSystemFields(obj);
  expect(without).toEqual({ a: "a" });
});

test("withoutSystemFields when fields aren't present", () => {
  const obj = { a: "a" };
  const without = withoutSystemFields(obj);
  expect(without).toEqual({ a: "a" });
});

test("withoutSystemFields type when it's a union", () => {
  const obj = { a: "a" } as { a: string } | { _id: string; _creationTime: number };
  const without = withoutSystemFields(obj);
  expect(without).toEqual({ a: "a" });
  // biome-ignore lint/complexity/noBannedTypes: the type convex-helpers' test expects
  check<Equals<typeof without, { a: string } | {}>>();
  const obj2 = { _id: "1", _creationTime: 1, a: "a" } as
    | { _id: string; _creationTime: number; a: string }
    | { _id: string; _creationTime: number; b: string };
  const without2 = withoutSystemFields(obj2);
  expect(without2).toEqual({ a: "a" });
  check<Equals<typeof without2, { a: string } | { b: string }>>();
});

test("withoutSystemFields works on validators too", () => {
  const validator = v.object({
    _id: v.string(),
    _creationTime: v.number(),
    a: v.string(),
  });
  const { _id, _creationTime, ..._rest } = validator.fields;
  const without = withoutSystemFields(validator.fields);
  check<Equals<typeof without, typeof _rest>>();
  expect(Object.keys(without)).toEqual(["a"]);
});

describe("the utilities convex-helpers' test leaves out", () => {
  test("asyncMap starts every call before awaiting any, and keeps the list's order", async () => {
    const started: number[] = [];
    const release: (() => void)[] = [];
    const result = asyncMap([10, 20, 30], (item, index) => {
      started.push(index);
      return new Promise<string>((resolve) => release.push(() => resolve(`${item}@${index}`)));
    });
    // asyncMap awaits the list first, then starts them all.
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    for (const r of release.reverse()) r(); // settle them in reverse: the result keeps the list's order
    expect(await result).toEqual(["10@0", "20@1", "30@2"]);
  });

  test("asyncMap takes a promise of an iterable, a Set and an empty list", async () => {
    const double = async (n: number) => n * 2;
    expect(await asyncMap(Promise.resolve([1, 2]), double)).toEqual([2, 4]);
    expect(await asyncMap(new Set([3, 3, 4]), double)).toEqual([6, 8]);
    expect(await asyncMap([], double)).toEqual([]);
    const result: Promise<number[]> = asyncMap(Object.keys({ a: 1 }), async (k) => k.length);
    expect(await result).toEqual([1]);
  });

  test("asyncMap rejects with the first rejection", async () => {
    await expect(
      asyncMap([1, 2], async (n) => {
        if (n === 2) throw new Error("two");
        return n;
      }),
    ).rejects.toThrow("two");
  });

  test("pruneNull drops nulls only", () => {
    const pruned = pruneNull([1, null, 0, undefined, null, 2]);
    expect(pruned).toEqual([1, 0, undefined, 2]);
    check<Equals<typeof pruned, (number | undefined)[]>>();
  });

  test("nullThrows: the value, or a NullDocumentError with the default or given message", () => {
    const doc = { a: 1 } as { a: number } | null;
    const value = nullThrows(doc);
    check<Equals<typeof value, { a: number }>>();
    expect(value).toBe(doc!);
    expect(nullThrows(0)).toBe(0);
    expect(nullThrows(undefined)).toBe(undefined);
    expect(() => nullThrows(null)).toThrow(new NullDocumentError("Unexpected null document."));
    expect(() => nullThrows(null, "no user")).toThrow("no user");
    try {
      nullThrows(null);
    } catch (e) {
      expect(e).toBeInstanceOf(NullDocumentError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("Unexpected null document.");
      expect((e as Error).name).toBe("Error");
    }
  });

  test("assert: passes truthy values, throws an Error with the message (or its function's) otherwise", () => {
    const x = "set" as string | null;
    assert(x);
    check<Equals<typeof x, string>>();
    expect(() => assert(0)).toThrow(Error);
    try {
      assert(false);
    } catch (e) {
      expect((e as Error).message).toBe("");
    }
    expect(() => assert(null, "missing")).toThrow("missing");
    let calls = 0;
    const message = () => {
      calls++;
      return "built lazily";
    };
    assert(true, message);
    expect(calls).toBe(0);
    expect(() => assert("", message)).toThrow("built lazily");
    expect(calls).toBe(1);
  });

  test("the type helpers", () => {
    check<Equals<EmptyObject, Record<string, never>>>();
    const reason = "bad" as ErrorMessage<"bad">;
    const asString: string = reason;
    expect(asString).toBe("bad");
    check<Equals<Equals<1, 1>, true>>();
    check<Equals<Equals<1, number>, false>>();
  });
});
