// A nested call's error from an action (the app of `nested-errors-app/`) on Convex's backend (the oracle) and on
// bunvex's: V8 and "use node" actions calling a query, a mutation, a V8 and a Node action that throw, the error left
// uncaught (the client's message and data) or caught (what the action sees: name, message, data). Only decided
// differences are rewritten: the class's name and the functions' directory (DV-03), and frame positions (DV-346).
// `error.stack` read by the action itself is not compared (STUDY-95's open gap). Local only: skipped, with a note,
// when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`nested-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../nested-errors-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const decided = (s: string) =>
  s
    .replace(/\[Request ID: [0-9a-f]{16}\] /g, "")
    .replaceAll("ConvexError", "BunvexError")
    .replaceAll("../convex/", "../bunvex/")
    .replace(/:\d+:\d+\)/g, ":N:N)");

async function answer(b: Backend, path: string, target: string) {
  const { body } = await b.call("action", path, { target });
  const a = body as Record<string, unknown>;
  if (a.status === "error") return { error: decided(String(a.errorMessage)), data: a.errorData ?? null };
  const caught = a.value as { name: string; message: string; data: unknown } | null;
  return caught && { name: decided(caught.name), message: decided(caught.message), data: caught.data };
}

const TARGETS = ["queryApp", "queryPlainError", "querySubclass", "mutationApp", "actionApp", "nodeApp"];

describe.skipIf(!ready)("a nested call's error from an action, against Convex's backend", () => {
  for (const [caller, uncaught, caught] of [
    ["a V8 action", "errors:callUncaught", "errors:callCaught"],
    ["a Node action", "node:nodeCallUncaught", "node:nodeCallCaught"],
  ] as const)
    test(`${caller}: uncaught, the callee's display and the caller's await; caught, its name, message and data`, async () => {
      for (const target of TARGETS) {
        const c = await answer(convex, uncaught, target);
        expect({ target, ...(await answer(bunvex, uncaught, target)) }).toEqual({ target, ...c });
        expect((c as { error: string }).error).toMatch(/\n\n {4}at async <anonymous> \(\.\.\/bunvex\/\w+\.ts:N:N\)\n$/);
        expect({ target, ...(await answer(bunvex, caught, target)) }).toEqual({
          target,
          ...(await answer(convex, caught, target)),
        });
      }
    });
});
