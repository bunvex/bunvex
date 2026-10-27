// `node.nodeVersion` on push (STUDY-145; STUDY-186 A15, Convex's `1d7e847`), on Convex's backend (the oracle) and on
// bunvex's: the answer of `start_push`, `evaluate_push` and `evaluate_schema` to each version, compared answer by
// answer. "18" and "20" are refused as no longer supported (400), "22" and "24" accepted; anything else is not a
// version. Convex's refusal ends with a link to its docs, which bunvex's leaves out (DV-04), so the link is cut
// before comparing. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`node-version: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
}, 180_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** A push step's answer to `nodeVersion`: its status, and its code and message (Convex's docs link cut). */
async function answer(b: Backend, step: string, nodeVersion: unknown) {
  const r = await fetch(`${b.url}/api/deploy2/${step}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminKey: b.adminKey,
      functions: "convex/",
      appDefinition: {
        definition: null,
        dependencies: [],
        schema: null,
        changedModules: [{ path: "a.js", source: "export const x = 1;", environment: "isolate" }],
        unchangedModuleHashes: [],
        udfServerVersion: "1.48.0",
      },
      componentDefinitions: [],
      nodeDependencies: [],
      ...(nodeVersion === undefined ? {} : { nodeVersion }),
    }),
  });
  const text = await r.text();
  let body: { code?: string; message?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (r.status === 200) return { status: 200 };
  return { status: r.status, code: body.code, message: body.message?.replace(/ \(https:\/\/[^)]*\)\.$/, ".") };
}

describe.skipIf(!ready)("nodeVersion on push, against Convex's backend", () => {
  for (const step of ["start_push", "evaluate_push", "evaluate_schema"])
    for (const version of ["18", "20", "22", "24", "16", "v20", "", undefined, null])
      test(`${step} with nodeVersion ${JSON.stringify(version)}`, async () => {
        const [c, b] = [await answer(convex, step, version), await answer(bunvex, step, version)];
        expect({ step, version, ...b }).toEqual({ step, version, ...c });
      });

  test("Node 20 is refused as Node 18 is, on Convex's backend", async () => {
    const c = await answer(convex, "start_push", "20");
    expect(c).toMatchObject({
      status: 400,
      message: expect.stringContaining("Node 20 is no longer supported. Upgrade to a newer Node version."),
    });
  });
});
