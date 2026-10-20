// The commit timestamp placeholder (STUDY-53), as Convex's `CommitTsPlaceholder`: unusable as a number or
// as JSON before the commit (a clear error, not a silent NaN or "{}"), printable, branded; and
// `resolveCommitTs` replaces it everywhere in a value, copying only the containers on the way.
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import {
  CommitTsPlaceholder,
  commitTsPlaceholder,
  hasCommitTs,
  isCommitTsPlaceholder,
  MAX_COMMIT_TS,
  resolveCommitTs,
  resolveCommitTsJson,
} from "../src/commit-ts.ts";

const UNRESOLVED = /unresolved: its value is assigned when the mutation commits/;

test("before the commit, the placeholder refuses numeric and JSON use", () => {
  const p = commitTsPlaceholder as unknown as number;
  expect(() => p + 1).toThrow(UNRESOLVED);
  expect(() => p < 5).toThrow(UNRESOLVED);
  expect(() => Number(p)).toThrow(UNRESOLVED);
  expect(() => commitTsPlaceholder.valueOf()).toThrow(UNRESOLVED);
  expect(() => JSON.stringify({ t: commitTsPlaceholder })).toThrow(UNRESOLVED);
});

test("until the commit it stands for the largest int64, after every real timestamp", () => {
  expect(MAX_COMMIT_TS).toBe(9223372036854775807n);
});

test("it prints, is tagged, and is told apart from look-alikes", () => {
  expect(`${commitTsPlaceholder}`).toBe("[unresolved commit timestamp]");
  expect(String(commitTsPlaceholder)).toBe("[unresolved commit timestamp]");
  expect(Object.prototype.toString.call(commitTsPlaceholder)).toBe("[object CommitTsPlaceholder]");
  expect(CommitTsPlaceholder.isBranded(commitTsPlaceholder)).toBe(true);
  // An object that only claims the prototype has no brand.
  const fake = Object.create(CommitTsPlaceholder.prototype);
  expect(CommitTsPlaceholder.isBranded(fake)).toBe(false);
  expect(CommitTsPlaceholder.isBranded({ toString: () => "[unresolved commit timestamp]" })).toBe(false);
  expect(isCommitTsPlaceholder(commitTsPlaceholder)).toBe(true);
  expect(isCommitTsPlaceholder(5n)).toBe(false);
});

test("resolveCommitTs replaces every placeholder and copies only what changed", () => {
  const untouched = { a: [1, "x"], b: { c: null } };
  const bytes = new ArrayBuffer(2);
  const doc = { at: commitTsPlaceholder, list: [1, commitTsPlaceholder, [commitTsPlaceholder]], untouched, bytes };
  const r = resolveCommitTs(doc, 42n);
  expect(r).toEqual({ at: 42n, list: [1, 42n, [42n]], untouched, bytes } as never);
  expect(r).not.toBe(doc);
  expect(doc.at).toBe(commitTsPlaceholder); // the input is not mutated
  expect(r.untouched).toBe(untouched); // unchanged branches are shared, not copied
  expect(r.bytes).toBe(bytes);
  expect(resolveCommitTs(untouched, 42n)).toBe(untouched);
  expect(resolveCommitTs(commitTsPlaceholder, 7n)).toBe(7n as never);
  expect(resolveCommitTs("s", 7n)).toBe("s");
  // Class instances are not walked: only plain objects and arrays are values.
  const m = new Map([["k", commitTsPlaceholder]]);
  expect(resolveCommitTs(m, 7n)).toBe(m);
  const instance = new (class {
    at = commitTsPlaceholder;
  })();
  expect(resolveCommitTs(instance, 7n)).toBe(instance);
  expect(instance.at).toBe(commitTsPlaceholder);
});

test("hasCommitTs finds a placeholder at any depth of plain objects and arrays, and nowhere else", () => {
  expect(hasCommitTs(commitTsPlaceholder)).toBe(true);
  expect(hasCommitTs([1, [2, commitTsPlaceholder]])).toBe(true);
  expect(hasCommitTs({ a: 1, b: { c: [commitTsPlaceholder] } })).toBe(true);
  expect(hasCommitTs({ a: 1, b: commitTsPlaceholder })).toBe(true); // one field of several
  expect(hasCommitTs([commitTsPlaceholder, 1])).toBe(true); // one item of several
  for (const x of [null, undefined, 5, 5n, "s", true, [], {}, [1, "x"], { a: { b: null } }, new ArrayBuffer(8)])
    expect(hasCommitTs(x)).toBe(false);
  // Class instances and other objects are not values: not walked.
  expect(hasCommitTs(new Map([["k", commitTsPlaceholder]]))).toBe(false);
  expect(
    hasCommitTs(
      new (class {
        at = commitTsPlaceholder;
      })(),
    ),
  ).toBe(false);
});

test("resolveCommitTsJson writes the int64 tokens, little-endian base64", () => {
  expect(resolveCommitTsJson('{"a":1}', 5n)).toBe('{"a":1}');
  expect(resolveCommitTsJson('[{"$commitTs":null},{"$commitTs":null}]', 1n)).toBe(
    '[{"$integer":"AQAAAAAAAAA="},{"$integer":"AQAAAAAAAAA="}]',
  );
});

describe("objects of another realm (a pushed function's own, STUDY-171 §9)", () => {
  const theirs = vm.runInContext("(p) => ({ args: { at: p, list: [{ deep: p }] } })", vm.createContext({})) as (
    p: unknown,
  ) => { args: Record<string, unknown> };

  test("hasCommitTs looks into them", () => {
    expect(hasCommitTs(theirs(commitTsPlaceholder).args)).toBe(true);
    expect(hasCommitTs(theirs(1).args)).toBe(false);
  });

  test("resolveCommitTs resolves inside them", () => {
    const r = resolveCommitTs(theirs(commitTsPlaceholder).args, 5n) as { at: bigint; list: { deep: bigint }[] };
    expect([r.at, r.list[0]!.deep]).toEqual([5n, 5n]);
  });
});
