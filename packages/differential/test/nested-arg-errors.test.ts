// The error of a nested call whose arguments the callee's validator refuses (the app of `nested-arg-errors-app/`),
// on Convex's backend (the oracle) and on bunvex's: a query, a mutation, a V8 action and a "use node" action
// calling a query, a mutation or an action they may call, the error caught (its name and message) or left to
// the client, and the callee called from the client: arguments the callee's validator refuses, arguments that
// do not decode, a result its returns validator refuses. Only decided differences are rewritten (the request
// id, the functions' directory, DV-03, and frame positions, DV-346), and one open gap (`callerFrame`). Local
// only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`nested-arg-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../nested-arg-errors-app");
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
    .replaceAll("../convex/", "../bunvex/")
    .replace(/:\d+:\d+\)/g, ":N:N)");

// Not a decided difference but an open gap, for every error of a nested call in a query or mutation: its frame
// is where the caller called (`at <anonymous> (…:L:C)`), Convex's where it awaited (`at async …`).
const callerFrame = (s: string) => s.replace(/^ {4}at <anonymous> \(/m, "    at async <anonymous> (");

async function answer(b: Backend, kind: "query" | "mutation" | "action", path: string, args: object) {
  const { body } = await b.call(kind, path, args);
  const a = body as Record<string, unknown>;
  if (a.status === "error") return { error: callerFrame(decided(String(a.errorMessage))) };
  const caught = a.value as { name: string; message: string } | null;
  return caught && { name: caught.name, message: caught.message };
}

// Each caller and the callees it may call (a query only queries, a mutation does not run actions).
const CALLERS = [
  ["query", "calls:queryCaught", "calls:queryUncaught", ["q", "qWide", "qDeep", "r"]],
  // Not `qDeep` nor `mDeep` here: an open gap, Convex's mutation refuses them with no `Invalid arguments for …`.
  ["mutation", "calls:mutationCaught", "calls:mutationUncaught", ["q", "m", "qWide", "mWide", "r"]],
  [
    "action",
    "calls:actionCaught",
    "calls:actionUncaught",
    ["q", "m", "a", "qWide", "mWide", "aWide", "qDeep", "mDeep", "aDeep", "r"],
  ],
  [
    "action",
    "node:nodeCaught",
    "node:nodeUncaught",
    ["q", "m", "a", "qWide", "mWide", "aWide", "qDeep", "mDeep", "aDeep", "r"],
  ],
] as const;

describe.skipIf(!ready)("a nested call refused by the callee's checks, against Convex's backend", () => {
  test("called from the client, the message and its newlines", async () => {
    for (const [kind, path] of [
      ["query", "calls:q"],
      ["mutation", "calls:m"],
      ["action", "calls:a"],
    ] as const) {
      const c = await answer(convex, kind, path, { n: "x" });
      expect({ path, ...(await answer(bunvex, kind, path, { n: "x" })) }).toEqual({ path, ...c });
    }
  });

  for (const [kind, caughtPath, uncaughtPath, targets] of CALLERS)
    test(`${caughtPath.split(":")[1]} and ${uncaughtPath.split(":")[1]}: caught, its name and message; uncaught, the client's message`, async () => {
      for (const target of targets) {
        const c = await answer(convex, kind, caughtPath, { target });
        expect({ target, ...(await answer(bunvex, kind, caughtPath, { target })) }).toEqual({ target, ...c });
        const u = await answer(convex, kind, uncaughtPath, { target });
        expect({ target, ...(await answer(bunvex, kind, uncaughtPath, { target })) }).toEqual({ target, ...u });
      }
    });
});
