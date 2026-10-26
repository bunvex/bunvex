// A table created anywhere invalidates every cached query (STUDY-187 X22): Convex's table mapping is a read of all
// of `_tables` (`take_table_mapping_dep`), which every function that names a table takes. Found by the generated
// programs (seed 347098918): a query cached in one program, a mutation creating a table in another, the query
// again. Skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { compare, type Program } from "../harness/runner.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`differential: skipped, no Convex backend at ${ORACLE_BIN}`);

const read = { kind: "read", read: { table: "b", index: "by_x", range: [{ field: "x", op: "eq", value: "b" }] } };

describe.skipIf(!ready)("the table mapping as a read, on Convex and on bunvex", () => {
  let oracle: Backend;
  let bunvex: Backend;
  beforeAll(async () => {
    [oracle, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([oracle?.stop(), bunvex?.stop()]);
  });

  test("a cached query runs again after a mutation creates a table it never reads", async () => {
    // The second read is a cache hit on both; the mutation creates `nope` (the `limit` op's case 7); the third
    // read runs again.
    const program = [read, read, { kind: "apply", ops: [{ kind: "limit", which: 7 }] }, read] as Program;
    expect(await compare(oracle, bunvex, program, { reset: true, log: true })).toEqual([]);
  });

  test("a table created once: later queries are cached again", async () => {
    const program = [read, { kind: "apply", ops: [{ kind: "limit", which: 7 }] }, read, read] as Program;
    expect(await compare(oracle, bunvex, program, { reset: true, log: true })).toEqual([]);
  });
});
