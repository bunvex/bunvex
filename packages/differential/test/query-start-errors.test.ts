// A query's table and index when it starts (STUDY-161 §5), on Convex's backend (the oracle) and on bunvex's, for the
// app of `query-errors-app/`: a table or an index that does not exist (`Index <table>.<index> not found.`), names
// that do not parse (under ``Invalid argument `query` for `queryStream` `` or `queryPage`), and what still answers.
// The messages are compared without their frames (STUDY-150's). Local only: skipped, with a note, when Convex's
// backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`query-start-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../query-errors-app");
let convex: Backend;
let bunvex: Backend;

type How = "collect" | "first" | "iterate" | "paginate" | "search" | "range" | "limit";
const CASES: [string, string | undefined, How][] = [
  // a table that does not exist: a scan answers, any index is not found
  ["nope", undefined, "collect"],
  ["nope", undefined, "first"],
  ["nope", "by_creation_time", "collect"],
  ["nope", "by_id", "first"],
  ["nope", "by_creation_time", "iterate"],
  ["nope", "by_creation_time", "paginate"],
  ["nope", "by_k", "range"],
  ["nope", "s", "search"],
  // an index the table lacks
  ["free", "nope", "collect"],
  ["free", "_x", "paginate"],
  ["free", "t", "search"],
  ["free", "by_k", "range"],
  ["free", "by_id", "collect"],
  // names that do not parse
  ["9x", undefined, "collect"],
  ["", undefined, "first"],
  ["a-b", undefined, "collect"],
  ["a​b", undefined, "collect"],
  ["a b", undefined, "collect"],
  ["a'b", undefined, "collect"],
  ["9x", "by_creation_time", "collect"],
  ["9x", "by_creation_time", "paginate"],
  ["free", "9", "collect"],
  ["free", "", "collect"],
  ["nope", "9", "collect"],
  ["free", "a.b", "collect"],
  ["free", "9", "search"],
  ["9x", "s", "search"],
  // the operators come first
  ["9x", undefined, "limit"],
];

describe.skipIf(!ready)("a query's table and index when it starts, on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  const answer = async (b: Backend, table: string, index: string | undefined, how: How) => {
    const { body } = await b.call("query", "queries:run", { table, how, ...(index === undefined ? {} : { index }) });
    const a = body as { status: string; value?: unknown; errorMessage?: string };
    if (a.status === "success") {
      const value = a.value as { page?: unknown; isDone?: boolean } | unknown;
      // A page's cursors are each backend's own.
      return how === "paginate" && value && typeof value === "object"
        ? { page: (value as { page: unknown }).page, isDone: (value as { isDone: boolean }).isDone }
        : { value };
    }
    return { error: errorText(a.errorMessage ?? "") };
  };

  test("every case answers the same", async () => {
    const got = await Promise.all(
      CASES.map(async ([table, index, how]) => ({
        table,
        index,
        how,
        convex: await answer(convex, table, index, how),
        bunvex: await answer(bunvex, table, index, how),
      })),
    );
    for (const g of got) expect({ ...g, bunvex: g.bunvex }).toEqual({ ...g, bunvex: g.convex });
    // what the comparison stands on
    const byCase = (t: string, i: string | undefined, h: How) =>
      got.find((g) => g.table === t && g.index === i && g.how === h)!.convex;
    expect(byCase("nope", "by_creation_time", "collect")).toEqual({
      error: "Server Error\nUncaught Error: Index nope.by_creation_time not found.",
    });
    expect(byCase("nope", undefined, "collect")).toEqual({ value: [] });
    expect(byCase("free", "a.b", "collect")).toEqual({
      error:
        "Server Error\nUncaught Error: Invalid argument `query` for `queryStream`: Too many components in index name free.a.b",
    });
  }, 60_000);
});
