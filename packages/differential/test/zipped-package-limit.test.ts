// No zipped package limit (STUDY-186 A3, Convex's `5695d6d`), on Convex's backend (the oracle) and on bunvex's: both
// run with `MAX_ZIPPED_PACKAGES_SIZE` at 100 bytes, the knob that used to refuse a package that zips to that or more
// (400 `ModulesTooLarge`, "Total module size exceeded the zipped maximum"), and both deploy the app of
// `zipped-limit-app/` and run its query. The unzipped limit (230 000 000 bytes) is not a knob, so it is not shown
// here. Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`zipped-package-limit: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../zipped-limit-app");
const env = { MAX_ZIPPED_PACKAGES_SIZE: "100" };
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  // Each start deploys the app with its CLI: a refused push fails the start.
  [convex, bunvex] = await startAll([startConvex({ app: APP, env }), startBunvex({ app: APP, env })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

describe.skipIf(!ready)("no zipped package limit, against Convex's backend", () => {
  test("a package past MAX_ZIPPED_PACKAGES_SIZE deploys and runs on both", async () => {
    const [c, b] = [await convex.call("query", "hello:hello", {}), await bunvex.call("query", "hello:hello", {})];
    expect(c).toMatchObject({ ok: true, body: { status: "success", value: "hello" } });
    expect(b).toMatchObject({ ok: true, body: { status: "success", value: "hello" } });
  });
});
