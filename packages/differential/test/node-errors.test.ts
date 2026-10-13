// A "use node" action's process-level failures (platform §9) on Convex's backend (the oracle) and on bunvex's: an
// exception thrown in one of its callbacks and `process.exit`, with and without a code, each fail that action at once
// with the same message, one app frame each, and the next call works. Frames differ by design in their positions
// (the harness drops them); an unhandled rejection is not compared (bunvex leaves it to the process). Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`node-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../node-errors-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** An action's answer: its value, or its message without the request id and frames, and how many frames. */
async function run(b: Backend, path: string) {
  const body = (await (
    await fetch(`${b.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {}, format: "json" }),
    })
  ).json()) as { status: string; value?: unknown; errorMessage?: string };
  if (body.status === "success") return { value: body.value };
  const message = body.errorMessage ?? "";
  return { error: errorText(message), frames: message.split("\n").filter((l) => /^\s+at /.test(l)).length };
}

describe.skipIf(!ready)("a Node action's process-level failures, against Convex's backend", () => {
  for (const [path, error] of [
    ["node:callback", "Server Error\nUncaught uncaughtException: Yikes"],
    ["node:exit", "Server Error\nUncaught process.exit: process.exit() called with exit code 3"],
    ["node:exitNoCode", "Server Error\nUncaught process.exit: process.exit() called with no exit code"],
  ] as const)
    test(`${path}: the action fails at once, the next call works`, async () => {
      const c = await run(convex, path);
      expect(c).toEqual({ error, frames: 1 });
      expect(await run(bunvex, path)).toEqual(c);
      expect(await run(bunvex, "node:ok")).toEqual(await run(convex, "node:ok"));
    });
});
