// Log line limits by kind (STUDY-186 A1, Convex's `04e9983` + `0e4f90d`), on Convex's backend (the oracle) and on
// bunvex's, for the app of `log-limits-app/`: the lines a query, a mutation, a V8 action and a "use node" action
// return when they log past, at and under their limit (256 for a query or mutation, 1024 for an action, the last of
// them the overflow notice). A "use node" action's lines are Node's `util.inspect` of each number, as on Convex. Local
// only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`log-line-limits: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../log-limits-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** The lines a call returned: their count, the last two, and whether every other is the function's own. */
async function lines(b: Backend, kind: "query" | "mutation" | "action", path: string, n: number) {
  const { body } = await b.call(kind, path, { n });
  const r = body as { status: string; logLines?: string[]; errorMessage?: string };
  const all = r.logLines ?? [];
  return {
    status: r.status,
    error: r.errorMessage,
    count: all.length,
    tail: all.slice(-2),
    own: all.slice(0, -1).every((l, i) => l === `[LOG] ${i}`),
  };
}

const CASES: [kind: "query" | "mutation" | "action", path: string][] = [
  ["query", "logs:q"],
  ["mutation", "logs:m"],
  ["action", "logs:a"],
  ["action", "node:a"],
];

describe.skipIf(!ready)("log line limits, against Convex's backend", () => {
  for (const [kind, path] of CASES)
    for (const n of [255, 256, 1023, 1024, 1100])
      test(`${path} logging ${n} lines`, async () => {
        const [c, b] = [await lines(convex, kind, path, n), await lines(bunvex, kind, path, n)];
        expect(c.status).toBe("success");
        expect({ path, n, ...b }).toEqual({ path, n, ...c });
      });

  test("the limits as Convex's: 256 for a query or mutation, 1024 for a V8 or node action", async () => {
    const overflow = (max: number) => `[ERROR] Log overflow (maximum ${max}). Remaining log lines omitted.`;
    for (const [kind, path] of CASES) {
      const max = kind === "action" ? 1024 : 256;
      const c = await lines(convex, kind, path, 1100);
      expect({ path, count: c.count, last: c.tail[1] }).toEqual({ path, count: max, last: overflow(max) });
    }
  });
});
