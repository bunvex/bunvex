// Fixed programs on Convex's backend and on bunvex's (STUDY-122 phase 1): each is one shape a bug has taken
// or could take; both backends must answer every call alike and end with the same data. Skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh fetches it).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { LIMIT_CASES } from "../harness/generate.ts";
import { compare, type Program } from "../harness/runner.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`differential: skipped, no Convex backend at ${ORACLE_BIN}`);

/** The `limit` op's cases compared (`app/ops.ts` `pastLimit`), and the one left out until it is decided. */
const LIMITS = LIMIT_CASES;

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
  // Found by the generator (#486): bound errors name Convex's value (the equality already there) and print
  // values as Convex's `Display`; an equality and a bound on one field is Convex's inequality error.
  "index range bound errors": [
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { k: "a", n: 1 }, as: "r1" }] },
    ...(
      [
        [
          { field: "k", op: "eq", value: "a" },
          { field: "k", op: "eq", value: "b" },
        ],
        [
          { field: "k", op: "eq", value: 1 },
          { field: "k", op: "eq", value: 2.5 },
        ],
        [
          { field: "k", op: "eq", value: 1 },
          { field: "k", op: "gt", value: 0 },
        ],
        [
          { field: "k", op: "gt", value: 1 },
          { field: "k", op: "gte", value: 2 },
        ],
        [{ field: "n", op: "eq", value: 1 }],
      ] as const
    ).map((range) => ({ kind: "read" as const, read: { table: "a", index: "by_k_n", range } })),
  ],
  "errors of bad calls": [
    { kind: "apply", ops: [{ kind: "patch", id: { ref: "nothing" }, fields: { n: 1 } }] },
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { $bad: 1 }, as: "r1" }] },
    { kind: "apply", ops: [{ kind: "insert", table: "a", doc: { _id: "x" }, as: "r2" }] },
  ],
  // STUDY-122 phase 3: nested calls, actions, errors and limits.
  "a caught nested mutation rolls back its own writes only": [
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "outer" }, as: "r1" },
        {
          kind: "nested",
          catch: true,
          ops: [
            { kind: "insert", table: "a", doc: { k: "inner" }, as: "r2" },
            { kind: "patch", id: { ref: "r1" }, fields: { n: 1 } },
            { kind: "throw", message: "inner failure" },
          ],
        },
        { kind: "runQuery", read: { table: "a" } },
        { kind: "nested", ops: [{ kind: "insert", table: "b", doc: { x: 1 }, as: "r3" }] },
        { kind: "get", id: { ref: "r1" } },
      ],
    },
    { kind: "read", read: { table: "b" } },
  ],
  "a nested query sees the transaction's writes": [
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "a", n: 1 }, as: "r1" },
        { kind: "runQuery", read: { table: "a", index: "by_k", range: [{ field: "k", op: "eq", value: "a" }] } },
        { kind: "nested", ops: [{ kind: "runQuery", read: { table: "a" } }] },
      ],
    },
  ],
  "an uncaught nested failure fails the whole mutation": [
    {
      kind: "apply",
      ops: [
        { kind: "insert", table: "a", doc: { k: "kept?" }, as: "r1" },
        { kind: "nested", ops: [{ kind: "throw", message: "inner failure" }] },
      ],
    },
    { kind: "read", read: { table: "a" } },
  ],
  "application errors carry their data": [
    { kind: "apply", ops: [{ kind: "throwData", data: { code: 7, list: [1, "a", null, true] } }] },
    { kind: "apply", ops: [{ kind: "throwData", data: "a string" }] },
    {
      kind: "apply",
      ops: [{ kind: "nested", catch: true, ops: [{ kind: "throwData", data: { nested: { deep: [1.5] } } }] }],
    },
    { kind: "action", steps: [{ kind: "throwData", data: { from: "action" } }] },
    {
      kind: "action",
      steps: [
        { kind: "mutation", catch: true, ops: [{ kind: "throwData", data: { from: "mutation" } }] },
        { kind: "mutation", catch: true, ops: [{ kind: "throw", message: "plain" }] },
      ],
    },
  ],
  "an action's mutations stay when it fails later": [
    {
      kind: "action",
      steps: [
        { kind: "mutation", ops: [{ kind: "insert", table: "a", doc: { k: "act" }, as: "r1" }] },
        { kind: "query", read: { table: "a" } },
        {
          kind: "mutation",
          catch: true,
          ops: [
            { kind: "insert", table: "b", doc: { x: 2 }, as: "r2" },
            { kind: "throw", message: "rolled back" },
          ],
        },
        { kind: "throw", message: "action failure" },
      ],
    },
    { kind: "read", read: { table: "a" } },
    { kind: "read", read: { table: "b" } },
  ],
  "an action's answer": [
    {
      kind: "action",
      steps: [
        { kind: "mutation", ops: [{ kind: "insert", table: "a", doc: { k: "x", n: 2 }, as: "r1" }] },
        { kind: "query", read: { table: "a", mode: "first" } },
      ],
    },
    { kind: "apply", ops: [{ kind: "get", id: { ref: "r1" } }] },
  ],
  "validated arguments and result": [
    { kind: "typed", args: { n: 1 } },
    { kind: "typed", args: { n: 2, s: "s" } },
    { kind: "typed", args: { n: "one" } },
    { kind: "typed", args: {} },
    { kind: "typed", args: { n: 3, extra: true } },
    { kind: "typed", args: { n: 4, s: null } },
    { kind: "typed", args: { n: 5, bad: true } },
    { kind: "read", read: { table: "b" } },
  ],
  // STUDY-135: a lone surrogate along each path, every message and column as Convex's.
  "lone surrogates along each path": [
    { kind: "call", fn: "mutation", path: "surrogates:writes", args: {} },
    { kind: "call", fn: "query", path: "surrogates:queries", args: {} },
    { kind: "call", fn: "mutation", path: "surrogates:nested", args: {} },
    { kind: "call", fn: "action", path: "surrogates:fromAction", args: {} },
    { kind: "call", fn: "query", path: "surrogates:ret", args: {} },
    { kind: "call", fn: "mutation", path: "surrogates:retObject", args: {} },
    { kind: "call", fn: "action", path: "surrogates:retAction", args: {} },
    { kind: "call", fn: "query", path: "surrogates:echoQ", args: { s: "\ud800" } },
    { kind: "call", fn: "mutation", path: "surrogates:logs", args: {} },
    { kind: "call", fn: "mutation", path: "surrogates:throwsMessage", args: {} },
    { kind: "call", fn: "mutation", path: "surrogates:throwsDataObject", args: {} },
  ],
  "writes past the limits, caught and not": [
    ...LIMITS.map((which) => ({ kind: "apply" as const, ops: [{ kind: "limit" as const, which, catch: true }] })),
    ...LIMITS.map((which) => ({ kind: "apply" as const, ops: [{ kind: "limit" as const, which }] })),
    { kind: "read", read: { table: "a" } },
    { kind: "read", read: { table: "b" } },
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
