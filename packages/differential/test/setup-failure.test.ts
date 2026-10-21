// A setup that fails leaves no backend running (STUDY-122's harness): when Convex's side fails in `beforeAll`, the
// bunvex backend started beside it is stopped too, by its own handle. With `Promise.all`, the start that failed
// rejected at once and bunvex's went on, its handle lost: one run left 24 processes behind. Runs with or without
// Convex's backend: its side fails either way (no binary, or an app directory that does not exist).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { runningBackends, startAll, startBunvex, startConvex, stopEveryBackend } from "../harness/backends.ts";

/** Every process below this one (`pgrep -P`, walked; on Linux and macOS), the `pgrep`s themselves left out. */
function descendants(of = process.pid): number[] {
  const r = Bun.spawnSync(["pgrep", "-P", String(of)]);
  const kids = new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== r.pid);
  return kids.flatMap((pid) => [pid, ...descendants(pid)]);
}

let before: Set<number>;
let failure: unknown;
let left: number[] = [];
/** bunvex's backend, once up: the setup did start one beside the failure. */
let bunvexUrl: string | undefined;

beforeAll(async () => {
  before = new Set(descendants());
  try {
    await startAll([
      startConvex({ app: join(import.meta.dir, "no-such-app") }),
      // Under the process sandbox, as the run that leaked: its backend has children of its own, which go with it.
      startBunvex({ env: { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" } }).then(
        (b) => {
          bunvexUrl = b.url;
          return b;
        },
      ),
    ]);
  } catch (e) {
    failure = e;
  }
  left = descendants().filter((pid) => !before.has(pid));
}, 120_000);

// Whatever the test finds, nothing it started outlives it.
afterAll(() => stopEveryBackend());

test("Convex's side fails in beforeAll: the setup fails, and no backend it started is left running", () => {
  expect(failure).toBeInstanceOf(Error);
  expect(left).toEqual([]);
  expect(runningBackends()).toEqual([]);
  // Not vacuous: bunvex's side did come up, and was stopped.
  expect(bunvexUrl).toBeString();
});

test("the bunvex backend it started answers no more", async () => {
  expect(bunvexUrl).toBeString();
  expect(
    await fetch(`${bunvexUrl}/instance_name`).then(
      () => "answered",
      () => "refused",
    ),
  ).toBe("refused");
});
