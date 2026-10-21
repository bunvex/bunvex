// convex-helpers' streams (STUDY-181 PR 3, H-2) on Convex's backend (the oracle) with convex-helpers 0.1.128, and on
// bunvex's with `@bunvex/helpers`: the same documents (index keys of every value type, a missing field, strings
// ending in "undefined"), the same streams (index ranges, creation time, filterWith, map, mergedStream, distinct,
// flatMap, a loose index scan, streamIndexRange) paged to their end in both orders, with and without row and byte
// budgets, each page read again up to its own end; then single pages from fabricated cursors, from each
// backend's own document cursors fed to other streams, and the error cases. Pages and cursors must match byte for
// byte, but for each backend's ids and creation times, which the app replaces by labels (`<id n>`, `<ct n>`).
// Then convex-helpers' pagination (PR 4): `getPage` walked to the end of each index and each page read again up to
// its last key, single pages between given keys with every inclusivity, its two refusals, and `paginator`'s pages
// with `endCursor`: the same documents, `hasMore` and raw index keys.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convexToJson, type Value } from "convex/values";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`helpers-stream: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../helpers-stream-app");
let convex: Backend;
let bunvex: Backend;

/** bunvex's project imports `@bunvex/helpers` where Convex's imports convex-helpers (an app's one rename). */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  for (const name of readdirSync(functions)) {
    const file = join(functions, name);
    const source = readFileSync(file, "utf8");
    writeFileSync(
      file,
      source
        .replaceAll('"convex-helpers/server/stream"', '"@bunvex/helpers/server/stream"')
        .replaceAll('"convex-helpers/server/pagination"', '"@bunvex/helpers/server/pagination"'),
    );
  }
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
  for (const b of [convex, bunvex]) {
    const r = await b.call("mutation", "streams:seed", {});
    if (!r.ok) throw new Error(`seed failed on ${b.name}: ${JSON.stringify(r.body)}`);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const value = (r: { ok: boolean; body: unknown }) => {
  if (!r.ok) throw new Error(`call failed: ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
};
const both = async (path: string, args: Record<string, unknown>) =>
  Promise.all([convex, bunvex].map(async (b) => value(await b.call("query", path, args))));

const SCENARIOS = [
  "plain",
  "group",
  "range",
  "creation",
  "filter",
  "map",
  "merged",
  "distinct",
  "flatMap",
  "looseScan",
  "indexRange",
];
const ORDERS = ["asc", "desc"] as const;
const BUDGETS: Record<string, number>[] = [{}, { maximumRowsRead: 2 }, { maximumBytesRead: 120 }];

/** A cursor as convex-helpers writes one, for a key without system fields: the same text on both backends. */
const wire = (key: (Value | undefined)[]) =>
  JSON.stringify(
    convexToJson(
      key.map((x) => (x === undefined ? "undefined" : typeof x === "string" && x.endsWith("undefined") ? `_${x}` : x)),
    ),
  );
const FABRICATED = [
  "[]",
  ...[
    [undefined],
    [null],
    [false],
    [true],
    [-2n],
    [2n],
    [Number.NEGATIVE_INFINITY],
    [-1],
    [-0],
    [0],
    [1.5],
    [Number.POSITIVE_INFINITY],
    [Number.NaN],
    [""],
    ["a"],
    ["undefined"],
    ["_undefined"],
    ["x_undefined"],
    [new Uint8Array([0, 255]).buffer],
    [[0, 1]],
    [{ tag: 1 }],
    [undefined, 1],
    ["a", 2],
    [-0, 0],
    [1, 1],
    [1, 1, 0],
  ].map(wire),
];

describe.skipIf(!ready)(
  "convex-helpers' streams: Convex with convex-helpers 0.1.128, bunvex with @bunvex/helpers",
  () => {
    test("every stream paged to its end: the same pages, statuses and cursors", async () => {
      const differences: unknown[] = [];
      let pages = 0;
      for (const scenario of SCENARIOS)
        for (const order of ORDERS)
          for (const numItems of [1, 5])
            for (const budget of BUDGETS) {
              const args = { scenario, order, numItems, ...budget };
              const [c, b] = (await both("streams:walk", args)) as unknown[][];
              pages += c!.length;
              if (JSON.stringify(c) !== JSON.stringify(b)) differences.push({ args, convex: c, bunvex: b });
            }
      expect(differences).toEqual([]);
      // The walks did read pages, with cursors that hold every value type (checked byte for byte above).
      expect(pages).toBeGreaterThan(1000);
    }, 300_000);

    test("the cursors hold the value JSON, the undefined escape and the end marker", async () => {
      const [c] = (await both("streams:walk", { scenario: "plain", order: "asc", numItems: 1 })) as {
        continueCursor: string;
      }[][];
      const cursors = c!.map((p) => p.continueCursor);
      for (const expected of [
        '["undefined",',
        "[null,",
        '[{"$integer":"/v////////8="},',
        '[{"$float":"AAAAAAAA8P8="},',
        '[{"$float":"AAAAAAAAAIA="},',
        '[{"$float":"AAAAAAAA+H8="},',
        "[1.5,",
        '["_undefined",',
        '["__undefined",',
        '["_x_undefined",',
        '[{"$bytes":"AP8="},',
        "[[0,1],",
        '[{"tag":1},',
      ])
        expect(cursors.some((x) => x.startsWith(expected))).toBe(true);
      expect(cursors.at(-1)).toBe("[]");
    }, 60_000);

    test("pages from fabricated cursors, as start and as end", async () => {
      const differences: unknown[] = [];
      for (const scenario of SCENARIOS)
        for (const order of ORDERS)
          for (const cursor of FABRICATED)
            for (const args of [
              { scenario, order, cursor, numItems: 3 },
              { scenario, order, cursor: null, endCursor: cursor, numItems: 3 },
            ]) {
              const [c, b] = await both("streams:page", args);
              if (JSON.stringify(c) !== JSON.stringify(b)) differences.push({ args, convex: c, bunvex: b });
            }
      expect(differences).toEqual([]);
    }, 300_000);

    test("each backend's own document cursors, fed to every stream", async () => {
      const differences: unknown[] = [];
      for (const order of ORDERS) {
        const [c, b] = (await both("streams:keys", { order })) as { raw: string; named: string }[][];
        expect(c!.map((x) => x.named)).toEqual(b!.map((x) => x.named));
        for (const scenario of SCENARIOS)
          for (const [i, own] of c!.entries()) {
            // Every other document's key (and the last), which covers each value type.
            if (i % 2 === 1 && i !== c!.length - 1) continue;
            for (const end of [false, true]) {
              const argsOf = (raw: string) =>
                end
                  ? { scenario, order, cursor: null, endCursor: raw, numItems: 2 }
                  : { scenario, order, cursor: raw, numItems: 2 };
              const [rc, rb] = await Promise.all([
                convex.call("query", "streams:page", argsOf(own.raw)).then(value),
                bunvex.call("query", "streams:page", argsOf(b![i]!.raw)).then(value),
              ]);
              if (JSON.stringify(rc) !== JSON.stringify(rb))
                differences.push({ scenario, order, cursor: own.named, end, convex: rc, bunvex: rb });
            }
          }
      }
      expect(differences).toEqual([]);
    }, 300_000);

    test("the errors: numItems 0 without a cursor, an index range the stream refuses", async () => {
      const cases = [
        { scenario: "plain", order: "asc", cursor: null, numItems: 0 },
        { scenario: "plain", order: "asc", cursor: "", numItems: 0 },
        { scenario: "plain", order: "desc", cursor: "[]", numItems: 0 },
        { scenario: "badRange", order: "asc", cursor: null, numItems: 1 },
      ];
      const answers = [];
      for (const args of cases) {
        const [c, b] = await both("streams:page", args);
        expect({ args, answer: b }).toEqual({ args, answer: c });
        answers.push(c);
      }
      expect(answers).toEqual([
        {
          error:
            "Error: .paginate called with cursor of null and 0 for numItems. This is not supported, as null is not a valid continueCursor. Advice: avoid calling paginate entirely in these cases.",
        },
        { page: [], isDone: false, continueCursor: "", pageStatus: null, splitCursor: null },
        { page: [], isDone: false, continueCursor: "[]", pageStatus: null, splitCursor: null },
        { error: "Error: Cannot use eq on field 'g'" },
      ]);
    }, 60_000);

    test("getPage walked to the end of each index: the same pages, hasMore and index keys", async () => {
      const differences: unknown[] = [];
      let pages = 0;
      for (const index of ["creation", "k_g", "g_k"])
        for (const order of ORDERS)
          for (const limits of [{ targetMaxRows: 1 }, { targetMaxRows: 7 }, { targetMaxRows: 7, absoluteMaxRows: 3 }]) {
            const args = { index, order, ...limits };
            const [c, b] = (await both("pages:walk", args)) as unknown[][];
            pages += c!.length;
            if (JSON.stringify(c) !== JSON.stringify(b)) differences.push({ args, convex: c, bunvex: b });
          }
      expect(differences).toEqual([]);
      expect(pages).toBeGreaterThan(100);
    }, 300_000);

    test("getPage between given keys, every inclusivity, and its refusals", async () => {
      const KEYS = [
        undefined,
        [],
        ["$undefined"],
        [null],
        [false],
        [-1],
        [1.5],
        ["a"],
        ["undefined"],
        [1.5, 1],
        ["a", 2],
      ];
      const differences: unknown[] = [];
      for (const order of ORDERS)
        for (const start of KEYS)
          for (const end of KEYS)
            for (const startInclusive of [undefined, true, false])
              for (const endInclusive of [undefined, true, false]) {
                const args = { index: "k_g", order, start, end, startInclusive, endInclusive, targetMaxRows: 5 };
                const [c, b] = await both("pages:page", args);
                if (JSON.stringify(c) !== JSON.stringify(b)) differences.push({ args, convex: c, bunvex: b });
              }
      expect(differences).toEqual([]);
      const refusals = [
        { index: "creation", order: "asc", start: [1, "x", 3] },
        { index: "g_k", order: "desc", end: [1, 2, 3, 4, 5] },
        { index: "noSchema", order: "asc" },
      ];
      const answers = [];
      for (const args of refusals) {
        const [c, b] = await both("pages:page", args);
        expect({ args, answer: b }).toEqual({ args, answer: c });
        answers.push(c);
      }
      expect(answers).toEqual([
        { error: "Error: Index key length exceeds index fields length" },
        { error: "Error: Index key length exceeds index fields length" },
        { error: "Error: schema is required to infer index fields" },
      ]);
    }, 300_000);

    test("paginator's pages and endCursor", async () => {
      const differences: unknown[] = [];
      for (const order of ORDERS)
        for (const numItems of [1, 4]) {
          const [c, b] = await both("pages:paginate", { order, numItems });
          if (JSON.stringify(c) !== JSON.stringify(b)) differences.push({ order, numItems, convex: c, bunvex: b });
        }
      expect(differences).toEqual([]);
    }, 300_000);
  },
);
