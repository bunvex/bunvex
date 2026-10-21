// `bunvexTest` under the function sandbox (AD-44, STUDY-171 §8): with `BUNVEX_FUNCTION_SANDBOX=process`, the test's
// deployment runs the app's functions in the sandbox's children, as `bunvex-local-backend` does. Before
// `@bunvex/testing` provided the executor, its server refused to start (STUDY-171 §14); and `t.close()` must stop
// the children it started.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { PROCESS_SANDBOX_WARNING } from "@bunvex/server/executor";
import { bunvexTest } from "../src/index.ts";

const APP = join(import.meta.dir, "fixtures", "app");
const api = anyApi;

/** This process's live children, by PID (`ps`, on Linux and macOS): one that exited but is not reaped yet is gone. */
function children(): number[] {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,stat="]);
  return new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, ppid, stat]) => Number(ppid) === process.pid && Number(pid) !== r.pid && !stat?.startsWith("Z"))
    .map(([pid]) => Number(pid));
}

const saved = {
  sandbox: process.env.BUNVEX_FUNCTION_SANDBOX,
  isolation: process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION,
};
beforeEach(() => {
  process.env.BUNVEX_FUNCTION_SANDBOX = "process";
  process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION = "none";
});
afterEach(() => {
  for (const [name, value] of [
    ["BUNVEX_FUNCTION_SANDBOX", saved.sandbox],
    ["BUNVEX_FUNCTION_SANDBOX_ISOLATION", saved.isolation],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

test("BUNVEX_FUNCTION_SANDBOX=process: the app's functions run in the sandbox's children", async () => {
  const before = new Set(children());
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const t = bunvexTest({ cwd: APP });
  try {
    await t.mutation(api.messages.send, { body: "hi" });
    expect(await t.query(api.messages.list)).toEqual(["anonymous: hi"]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`bunvex: ${PROCESS_SANDBOX_WARNING}`);
    // At least one child of this process runs the app's code.
    expect(children().filter((pid) => !before.has(pid)).length).toBeGreaterThan(0);
  } finally {
    warn.mockRestore();
    await t.close();
  }
  // `close` stops them, by their own pids (the server's `shutdown`), and waits for them to exit.
  expect(children().filter((pid) => !before.has(pid))).toEqual([]);
}, 20_000);
