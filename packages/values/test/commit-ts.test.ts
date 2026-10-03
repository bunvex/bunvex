// The commit timestamp placeholder (STUDY-53), as Convex's `CommitTsPlaceholder`: unusable as a number or
// as JSON before the commit (a clear error, not a silent NaN or "{}"), printable, branded; and
// `resolveCommitTs` replaces it everywhere in a value, copying only the containers on the way.
import { expect, test } from "bun:test";
import {
  CommitTsPlaceholder,
  commitTsPlaceholder,
  isCommitTsPlaceholder,
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
});

test("resolveCommitTsJson writes the int64 tokens, little-endian base64", () => {
  expect(resolveCommitTsJson('{"a":1}', 5n)).toBe('{"a":1}');
  expect(resolveCommitTsJson('[{"$commitTs":null},{"$commitTs":null}]', 1n)).toBe(
    '[{"$integer":"AQAAAAAAAAA="},{"$integer":"AQAAAAAAAAA="}]',
  );
});
