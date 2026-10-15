// A written `_id` or `_creationTime` that is not the document's (STUDY-161 §4), on Convex's backend (the oracle) and on
// bunvex's, for the app of `system-fields-app/`: the messages' display of the field and of the value being written
// (an insert's, a replacement's, a merged patch), every kind of value. Compared after the request id, the frames
// (STUDY-150, DV-345), the ids and the document's own creation time (a clock). Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`system-fields: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../system-fields-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function error(b: Backend, args: unknown) {
  const { body } = await b.call("mutation", "writes:write", args);
  const a = body as { status: string; errorMessage?: string };
  expect({ args, status: a.status }).toEqual({ args, status: "error" });
  // Not `errorText`: it masks every `_creationTime` in a display, the very field compared here.
  return a
    .errorMessage!.replace(/^\[Request ID: [^\]]+\] /, "")
    .replace(/Provided creation time [\d.]+ /, "Provided creation time <time> ")
    .replace(/"[0-9a-hjkmnp-tv-z]{31,37}"/g, '"<id>"')
    .split("\n")
    .filter((l) => !/^\s+at /.test(l))
    .join("\n")
    .trim();
}

describe.skipIf(!ready)("a system-field mismatch's display, against Convex's backend", () => {
  test("the `_id` field and the value being written, as Convex displays them", async () => {
    const cases = [
      { method: "insert", value: { _creationTime: 1, k: 2 } },
      { method: "insert", value: { _creationTime: 1.5, s: "a", list: [1, null, true], o: { x: 1 } } },
      { method: "insert", value: { _id: 1, k: 2 } },
      { method: "insert", value: { _id: "x", _creationTime: 1 } },
      { method: "patch", value: { _creationTime: 1 } },
      { method: "patch", value: { _creationTime: 1 }, unset: ["gone"] },
      { method: "patch", value: { _creationTime: { $integer: "AQAAAAAAAAA=" } } },
      { method: "patch", value: { _creationTime: "x", z: 2 } },
      { method: "patch", value: { _id: 1 } },
      { method: "replace", value: { _creationTime: 1, k: 2 } },
      { method: "replace", value: { _id: "x" } },
      // bytes in the display (STUDY-161 §13)
      { method: "patch", value: { _creationTime: 1, z: { $bytes: "AQI=" } } },
      { method: "insert", value: { _id: { $bytes: "" } } },
    ];
    for (const args of cases) {
      const c = await error(convex, args);
      expect({ args, text: await error(bunvex, args) }).toEqual({ args, text: c });
    }
  });
});
