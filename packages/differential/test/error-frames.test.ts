// An error the engine throws into the app (the app of `error-frames-app/`), on Convex's backend (the oracle) and on
// bunvex's (STUDY-150): `db.patch` of `_creationTime`, `db.replace` of `_id`, a system table written, an id that does
// not parse, a `$` field, a function scheduled or called that does not exist; from a mutation, a V8 and a "use node"
// action. Left uncaught, the client's error shows the app's frames as Convex's (where it awaited the call, `at
// async …`, or made it); caught, the V8 `error.stack` is those frames alone, as Convex's `prepareStackTrace`; and
// nothing bunvex answers holds a frame or a path of the server's own. Only decided differences are rewritten:
// frame names (DV-345), positions (DV-346), the functions' directory (DV-03), Convex's library frames (DV-501).
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`error-frames: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../error-frames-app");
const REPO = resolve(import.meta.dir, "../../..");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** A frame of the app as both name it: no function name (DV-345), no position (DV-346), bunvex's directory (DV-03). */
const appFrame = (l: string) =>
  l
    .replace("../convex/", "../bunvex/")
    .replace(/^( {4}at (?:async )?).*? \((\.\.\/bunvex\/[^)]*):\d+:\d+\)$/, "$1<fn> ($2:N:N)");
/** The frame lines of a text: the app's normalised; Convex's bundled library's left out (DV-501). */
const framesOf = (text: string) =>
  text
    .split("\n")
    .filter((l) => /^ {4}at /.test(l) && !l.includes("node_modules/convex/"))
    .map(appFrame);

const MUTATION_CASES = ["patchCreationTime", "replaceId", "systemTable", "badId", "dollarField", "scheduleMissing"];
const ACTION_CASES = ["runQueryMissing", "scheduleMissing"];
const RUNS = [
  ...MUTATION_CASES.map((c) => ["mutation", "frames:uncaught", "frames:caught", c] as const),
  ...ACTION_CASES.map((c) => ["action", "frames:actionUncaught", "frames:actionCaught", c] as const),
  ...ACTION_CASES.map((c) => ["action", "node:nodeUncaught", "node:nodeCaught", c] as const),
];
/**
 * Where bunvex's frames are not yet Convex's (STUDY-150 §6): a bad id is refused before `db.get` awaits (Convex
 * parses it in its async syscall), and a missing function is refused by bunvex's server, not in the app's code
 * (Convex's `Couldn't resolve api.nope.x` in V8; a Node action's nested call keeps the callee's display, a blank line).
 */
const FRAMES_DIFFER = new Set([
  "mutation badId",
  "frames:actionUncaught runQueryMissing",
  "node:nodeUncaught runQueryMissing",
]);

describe.skipIf(!ready)("an engine-thrown error, against Convex's backend", () => {
  test("uncaught: the app's frames as Convex's, where it awaited or made the call", async () => {
    for (const [kind, uncaught, , c] of RUNS) {
      const answer = async (b: Backend) => {
        const { body } = await b.call(kind, uncaught, { c });
        const a = body as { status: string; errorMessage: string };
        expect({ uncaught, c, status: a.status }).toEqual({ uncaught, c, status: "error" });
        return framesOf(a.errorMessage);
      };
      const [cf, bf] = [await answer(convex), await answer(bunvex)];
      if (FRAMES_DIFFER.has(`${kind === "mutation" ? kind : uncaught} ${c}`)) continue;
      expect({ uncaught, c, frames: bf }).toEqual({ uncaught, c, frames: cf });
    }
  });

  test("caught in V8: `error.stack` is the app's frames alone, as Convex's; logged the same", async () => {
    for (const [kind, , caught, c] of RUNS) {
      if (caught.startsWith("node:")) continue;
      const answer = async (b: Backend) => {
        const { body } = await b.call(kind, caught, { c });
        const a = body as { value: { stack: string }; logLines: string[] };
        return { stack: a.value.stack, logged: a.logLines[1] ?? "" };
      };
      const [ca, ba] = [await answer(convex), await answer(bunvex)];
      // No header: the frames alone, as Convex's (udf-runtime `setupSourceMapping`).
      expect({ caught, c, head: ba.stack.split("\n")[0]!.startsWith("    at ") }).toEqual({ caught, c, head: true });
      if (FRAMES_DIFFER.has(`${kind === "mutation" ? kind : caught.replace("Caught", "Uncaught")} ${c}`)) continue;
      expect({ caught, c, stack: framesOf(ba.stack) }).toEqual({ caught, c, stack: framesOf(ca.stack) });
    }
  });

  test("caught in a Node action: `Error: <message>`, then frames, as Convex's executor heads them", async () => {
    for (const c of ACTION_CASES) {
      const { body } = await bunvex.call("action", "node:nodeCaught", { c });
      const stack = (body as { value: { stack: string; message: string } }).value;
      expect(stack.stack.startsWith(`Error: ${stack.message}\n    at `)).toBe(true);
      const { body: cb } = await convex.call("action", "node:nodeCaught", { c });
      expect((cb as { value: { stack: string } }).value.stack.startsWith("Error: ")).toBe(true);
    }
  });

  test("nothing bunvex answers holds a frame or a path of the server's own", async () => {
    const texts: string[] = [];
    for (const [kind, uncaught, caught, c] of RUNS)
      for (const path of [uncaught, caught]) texts.push(JSON.stringify((await bunvex.call(kind, path, { c })).body));
    for (const t of texts)
      expect({
        t,
        leaks:
          /packages\/(core|server|values)\/|bunvex-runtime:|bunvex:\/v\d|\(node:|processTicksAndRejections/.test(t) ||
          t.includes(REPO),
      }).toEqual({ t, leaks: false });
  });
});
