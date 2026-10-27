// A null body status (Convex's a74b7c3, npm-packages/udf-runtime/src/23_response.ts; STUDY-186 A5), on Convex's
// backend (the oracle) and on bunvex's: a `Response` built in a query and in a V8 action with 200, 204, 205, 206 and
// 304 and every kind of body, `Response.json` with 204, and a status out of range. Compared: what each gives, its
// error's name and message. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`null-body-status: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../null-body-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function outcomes(b: Backend, kind: "query" | "action", path: string) {
  const { body } = await b.call(kind, path, {});
  const a = body as { status: string; value?: Record<string, string>; errorMessage?: string };
  expect({ status: a.status, error: a.errorMessage }).toEqual({ status: "success", error: undefined });
  return a.value!;
}

describe.skipIf(!ready)("a Response with a null body status, against Convex's backend", () => {
  test("in a query and a V8 action: the same outcome for every status and body", async () => {
    for (const [kind, path] of [
      ["query", "responses:q"],
      ["action", "responses:a"],
    ] as const) {
      const c = await outcomes(convex, kind, path);
      expect(await outcomes(bunvex, kind, path)).toEqual(c);
      const NULL_BODY = "TypeError: Response with null body status cannot have body";
      expect([c["204 string"], c["205 empty"], c["304 stream"], c.json]).toEqual([
        NULL_BODY,
        NULL_BODY,
        NULL_BODY,
        NULL_BODY,
      ]);
      expect([c["204 null"], c["304 undefined"], c["206 string"], c.range]).toEqual([
        "ok 204",
        "ok 304",
        "ok 206",
        "RangeError",
      ]);
    }
  });
});
