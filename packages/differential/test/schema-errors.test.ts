// A schema error's display (STUDY-161 §3), on Convex's backend (the oracle) and on bunvex's, for the app of
// `schema-errors-app/`: a missing field, an extra field, a wrong value, a union of objects, by insert, patch and
// replace. The document and validator show no system field on either. The messages are compared after the request id
// and the frames (STUDY-150, DV-345). Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`schema-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../schema-errors-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function error(b: Backend, path: string, args: unknown) {
  const { body } = await b.call("mutation", path, args);
  const a = body as { status: string; errorMessage?: string };
  expect({ path, args, status: a.status }).toEqual({ path, args, status: "error" });
  return errorText(a.errorMessage!);
}

async function same(path: string, cases: unknown[]) {
  for (const args of cases) {
    const c = await error(convex, path, args);
    expect(c).not.toContain("_creationTime"); // what the comparison stands on
    expect({ args, text: await error(bunvex, path, args) }).toEqual({ args, text: c });
  }
}

describe.skipIf(!ready)("a schema error's display, against Convex's backend", () => {
  test("insert: missing, extra and wrong fields; a union of objects", async () => {
    await same("docs:insert", [
      { table: "strict", doc: {} },
      { table: "strict", doc: { n: 1 } },
      { table: "strict", doc: { name: "a", extra: 1 } },
      { table: "strict", doc: { name: 1 } },
      { table: "either", doc: { kind: "b" } },
      { table: "either", doc: { kind: "c" } },
      { table: "either", doc: { kind: "a", x: 1 } },
    ]);
  });

  test("patch and replace", async () => {
    await same("docs:write", [
      { method: "patch", value: {}, unset: ["name"] },
      { method: "patch", value: { extra: true } },
      { method: "replace", value: { n: 2 } },
      { method: "replace", value: { name: "y", extra: [1] } },
    ]);
  });
});
