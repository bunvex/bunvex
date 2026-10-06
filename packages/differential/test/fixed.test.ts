// Fixed programs on Convex's backend and on bunvex's (STUDY-122 phase 1): each is one shape a bug has taken
// or could take; both backends must answer every call alike and end with the same data. Skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh fetches it).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { compare, type Program } from "../harness/runner.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`differential: skipped, no Convex backend at ${ORACLE_BIN}`);

const PROGRAMS: Record<string, Program> = {
  "insert, patch, replace and delete": [
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "x", n: 1 }, as: "r1" },
        { kind: "insert", table: "a", doc: { k: "y", n: 2, nested: { list: [1, 2, { deep: true }] } }, as: "r2" },
        { kind: "insert", table: "b", doc: { x: 3 }, as: "r3" },
      ],
    },
    { kind: "apply", ops: [{ kind: "patch", id: { ref: "r3" }, fields: { link: { ref: "r1" } } }] },
    { kind: "apply", ops: [{ kind: "patch", id: { ref: "r1" }, fields: { n: 10, extra: "e" } }] },
    { kind: "apply", ops: [{ kind: "patch", id: { ref: "r2" }, fields: {} }] },
    { kind: "apply", ops: [{ kind: "replace", id: { ref: "r3" }, doc: { x: 4 } }] },
    {
      kind: "apply",
      ops: [
        { kind: "delete", id: { ref: "r2" } },
        { kind: "get", id: { ref: "r2" } },
      ],
    },
    { kind: "read", read: { table: "a" } },
  ],
  "a mutation reads its own writes": [
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "a", n: 1 }, as: "r1" },
        { kind: "patch", id: { ref: "r1" }, fields: { n: 2 } },
        { kind: "get", id: { ref: "r1" } },
        { kind: "insert", table: "a", doc: { k: "b", n: 0 }, as: "r2" },
        { kind: "read", read: { table: "a", index: "by_k_n", order: "desc" } },
        { kind: "delete", id: { ref: "r1" } },
        { kind: "read", read: { table: "a" } },
      ],
    },
  ],
  // #410: mutating documents a mutation read back (its own writes among them) must change nothing stored.
  "mutating a read result changes nothing stored": [
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { k: "old", n: 1 }, as: "r1" }] },
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "new", n: 2 }, as: "r2" },
        { kind: "patch", id: { ref: "r1" }, fields: { n: 5 } },
        { kind: "read", read: { table: "a" }, mutateResult: true },
        { kind: "get", id: { ref: "r1" } },
        { kind: "get", id: { ref: "r2" } },
      ],
    },
    { kind: "read", read: { table: "a", index: "by_k" } },
  ],
  "a failed mutation leaves nothing": [
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { k: "kept", n: 1 }, as: "r1" }] },
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "lost", n: 2 }, as: "r2" },
        { kind: "patch", id: { ref: "r1" }, fields: { n: 99 } },
        { kind: "throw", message: "stop here" },
      ],
    },
    { kind: "read", read: { table: "a" } },
  ],
  "index ranges and order": [
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "m", n: 3 }, as: "r1" },
        { kind: "insert", table: "a", doc: { k: "m", n: 1 }, as: "r2" },
        { kind: "insert", table: "a", doc: { k: "z", n: 2 }, as: "r3" },
        { kind: "insert", table: "a", doc: { n: 7 }, as: "r4" },
        { kind: "insert", table: "a", doc: { k: null, n: 0 }, as: "r5" },
        { kind: "insert", table: "a", doc: { k: 5, n: 0 }, as: "r6" },
      ],
    },
    { kind: "read", read: { table: "a", index: "by_k" } },
    { kind: "read", read: { table: "a", index: "by_k", order: "desc" } },
    { kind: "read", read: { table: "a", index: "by_k_n", range: [{ field: "k", op: "eq", value: "m" }] } },
    {
      kind: "read",
      read: {
        table: "a",
        index: "by_k_n",
        range: [
          { field: "k", op: "eq", value: "m" },
          { field: "n", op: "gt", value: 1 },
        ],
      },
    },
    { kind: "read", read: { table: "a", index: "by_k", range: [{ field: "k", op: "gte", value: "n" }], take: 1 } },
  ],
  // A result that is not a value fails the mutation whole: none of its writes stay.
  "a result that is not a value writes nothing": [
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { k: "kept", n: 1 }, as: "r1" }] },
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "lost", n: 2 }, as: "r2" },
        { kind: "patch", id: { ref: "r1" }, fields: { n: 99 } },
        { kind: "undefinedResult" },
      ],
    },
    { kind: "read", read: { table: "a" } },
  ],
  "values of every type": [
    {
      kind: "apply",
      ops: [
        {
          kind: "insert",
          table: "b",
          doc: { x: 1, s: "é ü 😀", f: 1.5, neg: -0.25, b: true, nul: null, arr: [], obj: {}, big: 2 ** 52 },
          as: "r1",
        },
      ],
    },
    { kind: "read", read: { table: "b", index: "by_x" } },
  ],
  "errors of bad calls": [
    { kind: "apply", ops: [{ kind: "patch", id: { ref: "nothing" }, fields: { n: 1 } }] },
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { $bad: 1 }, as: "r1" }] },
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { _id: "x" }, as: "r2" }] },
  ],
};

describe.skipIf(!ready)("the same program on Convex and on bunvex", () => {
  for (const [name, program] of Object.entries(PROGRAMS))
    test(name, async () => {
      // Fresh backends per program: what one leaves cannot explain another's differences.
      const [oracle, bunvex] = await Promise.all([startConvex(), startBunvex()]);
      try {
        expect(await compare(oracle, bunvex, program)).toEqual([]);
      } finally {
        await Promise.all([oracle.stop(), bunvex.stop()]);
      }
    });
});
