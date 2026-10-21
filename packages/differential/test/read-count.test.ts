// Counting reads toward the read limit (STUDY-161 §16), on Convex's backend (the oracle) and on bunvex's, for the app of
// `read-count-app/`: per index the merged intervals the function read, the engine's own reads left out, Convex's constant
// reads (a function's start, a table's creation, a first nested call). Both run with the limit at 60
// (`TRANSACTION_MAX_READ_SET_INTERVALS`), so the "Many reads" warning (past 80 %) shows the count of every shape below,
// and a shape at the limit fails at the same read on both. Also the dashboard's bulk edit at its limit, where the
// failing read decides whether the error is the function's application error (STUDY-149 "Bulk edit"). Local only:
// skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`read-count: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../read-count-app");
const LIMIT = 60;
/** Documents read by id first: with the function's 3 constant reads, past 80 % of the limit (the warning). */
const BASE = 46;
let convex: Backend;
let bunvex: Backend;
const ids = new Map<Backend, string[]>();

const call = async (b: Backend, kind: "query" | "mutation", path: string, args: unknown, admin = false) => {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(admin && { authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` }),
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()) as {
    status: string;
    value?: unknown;
    errorMessage?: string;
    errorData?: unknown;
    logLines?: string[];
  };
};

beforeAll(async () => {
  if (!ready) return;
  const env = { TRANSACTION_MAX_READ_SET_INTERVALS: String(LIMIT) };
  [convex, bunvex] = await startAll([startConvex({ app: APP, env }), startBunvex({ app: APP, env })]);
  for (const b of [convex, bunvex]) {
    await call(b, "mutation", "reads:fill", { table: "big", n: 60 });
    await call(b, "mutation", "reads:fill", { table: "small", n: 20 });
    await call(b, "mutation", "reads:fillText", {});
    ids.set(b, (await call(b, "query", "reads:ids", { n: 60 })).value as string[]);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** A shape's outcome: the count the warning shows past the `BASE` reads, or the error. */
async function outcome(b: Backend, kind: "q" | "m", ops: unknown[], base = BASE) {
  const all = ids.get(b)!;
  // "@n": the n-th document not read first
  const resolved = JSON.parse(
    JSON.stringify(ops).replace(/"@(\d+)"/g, (_m, n) => JSON.stringify(all[base + Number(n)])),
  );
  const r = await call(b, kind === "q" ? "query" : "mutation", `reads:${kind}`, {
    ids: all.slice(0, base),
    ops: resolved,
  });
  if (r.status !== "success") return { error: errorText(r.errorMessage ?? "") };
  const actual = (r.logLines ?? []).join("\n").match(/Many reads in a single function execution \(actual: (\d+)/)?.[1];
  return { reads: actual === undefined ? "under 80 %" : Number(actual) - base };
}

const SHAPES: [string, "q" | "m", unknown[]][] = [
  ["gets alone", "q", []],
  ["gets alone (mutation)", "m", []],
  ["a document again", "q", [["get", 0]]],
  ["patch a document read", "m", [["patch", 0]]],
  [
    "patch twice",
    "m",
    [
      ["patch", 1],
      ["patch", 1],
    ],
  ],
  ["replace a document read", "m", [["replace", 2]]],
  ["a document not read", "q", [["get", "@0"]]],
  ["patch a document not read", "m", [["patch", "@1"]]],
  ["delete a document not read", "m", [["delete", "@2"]]],
  ["insert", "m", [["insert", "other"]]],
  [
    "insert twice",
    "m",
    [
      ["insert", "other"],
      ["insert", "other"],
    ],
  ],
  [
    "insert, then get it",
    "m",
    [
      ["insert", "other"],
      ["getMade", 0],
    ],
  ],
  [
    "insert, then patch it",
    "m",
    [
      ["insert", "other"],
      ["patchMade", 0],
    ],
  ],
  [
    "insert, then scan its table",
    "m",
    [
      ["insert", "other"],
      ["first", "other"],
    ],
  ],
  [
    "insert three, then count the table",
    "m",
    [
      ["insert", "other"],
      ["insert", "other"],
      ["insert", "other"],
      ["count", "other"],
    ],
  ],
  ["the gets, then count their table", "q", [["count", "big"]]],
  ["a new table", "m", [["insert", "fresh1"]]],
  [
    "two new tables",
    "m",
    [
      ["insert", "fresh2"],
      ["insert", "fresh3"],
    ],
  ],
  [
    "a new table, then get its document",
    "m",
    [
      ["insert", "fresh4"],
      ["getMade", 0],
    ],
  ],
  ["first", "q", [["first", "small"]]],
  [
    "the same first twice",
    "q",
    [
      ["first", "small"],
      ["first", "small"],
    ],
  ],
  ["first of an empty table", "q", [["first", "other2"]]],
  ["collect", "q", [["collect", "small"]]],
  ["take 5", "q", [["take", "big", 5]]],
  ["desc first", "q", [["desc", "big"]]],
  ["filter", "q", [["filter", "small"]]],
  ["unique", "q", [["unique", "small"]]],
  ["withIndex eq", "q", [["eq", "small", "by_k", 3]]],
  [
    "withIndex eq twice",
    "q",
    [
      ["eq", "small", "by_k", 3],
      ["eq", "small", "by_k", 3],
    ],
  ],
  [
    "withIndex eq, two values",
    "q",
    [
      ["eq", "small", "by_k", 3],
      ["eq", "small", "by_k", 4],
    ],
  ],
  ["a range", "q", [["range", "big", "by_i", [10, 20]]]],
  [
    "adjacent ranges",
    "q",
    [
      ["range", "big", "by_i", [10, 20]],
      ["range", "big", "by_i", [20, 30]],
    ],
  ],
  [
    "overlapping ranges",
    "q",
    [
      ["range", "big", "by_i", [10, 20]],
      ["range", "big", "by_i", [15, 30]],
    ],
  ],
  [
    "ranges with a gap",
    "q",
    [
      ["range", "big", "by_i", [10, 20]],
      ["range", "big", "by_i", [21, 30]],
    ],
  ],
  ["a page", "q", [["page", "small", "by_k", 5]]],
  ["a missing table", "q", [["first", "nope"]]],
  [
    "two missing tables",
    "q",
    [
      ["first", "nope"],
      ["first", "nope2"],
    ],
  ],
  ["count of another table", "q", [["count", "small"]]],
  ["count of the table read by id", "q", [["count", "big"]]],
  ["a system table", "q", [["system"]]],
  ["normalizeId", "q", [["normalize", "big"]]],
  ["schedule", "m", [["schedule"]]],
  ["a search with hits", "q", [["search", "small", "hello"]]],
  [
    "the same search twice",
    "q",
    [
      ["search", "small", "hello"],
      ["search", "small", "hello"],
    ],
  ],
  ["a search with no hit", "q", [["search", "small", "zzz"]]],
  ["a nested query", "m", [["runQ", []]]],
  [
    "two nested calls",
    "m",
    [
      ["runQ", []],
      ["runM", []],
    ],
  ],
  ["a nested query from a query", "q", [["runQ", []]]],
  ["a nested query reading", "m", [["runQ", [["first", "small"]]]]],
  ["a nested query re-reading the caller's documents", "m", [["runQids", 30]]],
  ["a nested query of another module", "m", [["runOther"]]],
];

describe.skipIf(!ready)("counting reads, against Convex's backend", () => {
  test("every shape counts the same", async () => {
    const [c, b]: unknown[][] = [[], []];
    for (const [label, kind, ops] of SHAPES) {
      c.push({ label, ...(await outcome(convex, kind, ops)) });
      b.push({ label, ...(await outcome(bunvex, kind, ops)) });
    }
    expect(b).toEqual(c);
  });

  test("at the limit: the same shapes fail at the same read", async () => {
    // BASE + 3 + what the shape adds is past 60 for these: each fails, at the same statement on both.
    for (const [label, kind, ops] of SHAPES.filter(([l]) =>
      /first|ranges|search with hits|count of another|nested query reading/.test(l),
    ))
      for (const base of [55, 56, 57, 58]) {
        const c = await outcome(convex, kind, ops, base);
        expect({ label, base, ...(await outcome(bunvex, kind, ops, base)) }).toEqual({ label, base, ...c });
      }
  });

  test("a nested call's budget: the limit it reports, and where it runs out", async () => {
    const [c, b]: unknown[][] = [[], []];
    for (const budget of [0, 1, 2, 3])
      for (const ops of [
        [],
        [["first", "small"]],
        [
          ["first", "small"],
          ["first", "big"],
        ],
      ]) {
        c.push({ budget, ops, value: (await call(convex, "query", "reads:budgeted", { budget, ops })).value });
        b.push({ budget, ops, value: (await call(bunvex, "query", "reads:budgeted", { budget, ops })).value });
      }
    if (process.env.SHOW) console.log(JSON.stringify(c));
    expect(b).toEqual(c);
  });

  test("the dashboard's bulk edit at the limit: the error inside the function's rewrap on both", async () => {
    // `patchDocumentsFields` without ids: the table's documents, then a patch of each, then the audit event.
    for (const b of [convex, bunvex]) await call(b, "mutation", "reads:fill", { table: "bulk", n: 54 });
    for (let n = 54; n <= 58; n++) {
      const [c, x] = await Promise.all(
        [convex, bunvex].map(async (b) => {
          const r = await call(
            b,
            "mutation",
            "_system/frontend/patchDocumentsFields",
            { table: "bulk", fields: { p: n } },
            true,
          );
          if (r.status === "success") return { ok: true };
          return {
            error: errorText(r.errorMessage ?? "").replace("BunvexError", "ConvexError"),
            data: r.errorData !== undefined,
          };
        }),
      );
      expect({ n, bunvex: x }).toEqual({ n, bunvex: c });
      for (const b of [convex, bunvex]) await call(b, "mutation", "reads:fill", { table: "bulk", n: 1 });
    }
  });
});
