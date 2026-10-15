// A filter's errors (STUDY-161 §14), on Convex's backend (the oracle) and on bunvex's, for the app of
// `filter-errors-app/`: every value type's name (`Cannot negate …`, `… as a Boolean`, `Cannot add … and …`). The
// messages are compared after the request id and the frames (STUDY-150, DV-345). Local only: skipped, with a note,
// when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`filter-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../filter-errors-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
  await Promise.all([convex.call("mutation", "filters:seed", {}), bunvex.call("mutation", "filters:seed", {})]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function error(b: Backend, args: unknown) {
  const { body } = await b.call("query", "filters:run", args);
  const a = body as { status: string; errorMessage?: string };
  expect({ args, status: a.status }).toEqual({ args, status: "error" });
  return errorText(a.errorMessage!);
}

const INT = { $integer: "AQAAAAAAAAA=" };
const VALUES = [null, INT, 1.5, true, "s", { $bytes: "AQI=" }, [1], { a: 1 }];

describe.skipIf(!ready)("a filter's errors, against Convex's backend", () => {
  test("every value type's name", async () => {
    const cases = [
      ...[null, true, "s", { $bytes: "AQI=" }, [1], { a: 1 }].map((x) => ({ op: "neg", x })),
      { op: "neg", field: true },
      ...VALUES.filter((x) => x !== true).map((x) => ({ op: "bool", x })),
      { op: "bool", field: true },
      { op: "add", x: "s", y: [1] },
      { op: "mul", x: INT, y: 1.5 },
      { op: "sub", x: null, y: { $bytes: "" } },
    ];
    for (const args of cases) {
      const c = await error(convex, args);
      expect({ args, text: await error(bunvex, args) }).toEqual({ args, text: c });
    }
  });
});
