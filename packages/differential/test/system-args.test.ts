// A system function's arguments (STUDY-161 §6): Convex does not parse them before the run, the function's
// wrapper reads them, after the access check. Arguments the backend's parse would refuse (a `$` field, bad
// encodings, nesting) sent to `_system/frontend/addDocument` and `getTableMapping` as an admin on Convex's backend
// (the oracle) and on bunvex's; the messages and the data left are compared. Convex's frames
// (`at map [as map] (<anonymous>)`) are left out by the comparison (`errorText`). Local only: skipped, with a note,
// when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`system-args: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../dashboard-writes-app");

let convex: Backend;
let bunvex: Backend;

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

/** A function over the HTTP API (as an admin unless `admin` is false): its value or its error. */
async function call(b: Backend, kind: "query" | "mutation", path: string, args: unknown, admin = true) {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin && { authorization: authOf(b) }) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  return body.status === "success" ? { value: body.value } : { error: errorText(body.errorMessage ?? "") };
}

const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });

describe.skipIf(!ready)("a system function's arguments on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("a `$` field, bad encodings, nesting: the function's error, after the key", async () => {
    const run = async (b: Backend) => {
      const add = (documents: unknown) =>
        call(b, "mutation", "_system/frontend/addDocument", { table: "free", documents });
      const mapping = (args: unknown) => call(b, "query", "_system/frontend/getTableMapping", args);
      return {
        $x: await add([{ $x: 1 }]),
        nested$x: await add([{ a: [{ $x: 1 }] }]),
        control: await add([{ "a\u0001": 1 }]),
        integerNotBase64: await add([{ $integer: "zz" }]),
        integerNotString: await add([{ $integer: 1 }]),
        bytesNotString: await add([{ $bytes: 1 }]),
        floatTwoBytes: await add([{ $float: "AQI=" }]),
        commitTsNotNull: await add([{ $commitTs: 1 }]),
        levels64: await add([deep(62)]),
        levels65: await add([deep(63)]),
        query$x: await mapping({ $x: 1 }),
        queryArray: await mapping([{ $x: 1 }, { y: 1 }]),
        queryNested: await mapping({ x: { a: { $x: 1 } } }),
        noKey: await call(b, "mutation", "_system/frontend/addDocument", { documents: [{ $x: 1 }] }, false),
        noKeyQuery: await call(b, "query", "_system/frontend/getTableMapping", { $x: 1 }, false),
        written: (await call(b, "query", "ops:dump", { table: "free" })).value,
      };
    };
    const [c, x] = [await run(convex), await run(bunvex)];
    // what the comparison stands on
    expect(c.$x).toEqual({ error: "Server Error\nUncaught Error: Field name $x starts with a '$', which is reserved." });
    expect(c.written).toEqual([]);
    expect(x).toEqual(c);
  });
});
