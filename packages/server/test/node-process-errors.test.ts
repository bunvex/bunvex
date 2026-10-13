// A "use node" action's process-level failures (platform §9), as Convex's Node executor answers them
// (npm-packages/node-executor/src/executor.ts `unhandledRejectionHandler`): an exception thrown in one of its
// callbacks, or a call to `process.exit`, fails that action at once, named after the event, and the next call
// works. bunvex runs Node actions in its own process (DV-87), so neither may reach that process: the exception
// must not hang the action until its timeout, and `process.exit` must not stop the server. The server runs in a
// process of its own (fixtures/node-process-server.ts): the test runner keeps uncaught exceptions to itself.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

const servers: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
});

/** A server of its own, and a way to call its actions. */
async function start() {
  const server = Bun.spawn(["bun", join(import.meta.dir, "fixtures/node-process-server.ts")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(server);
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!/PORT \d+/.test(output)) {
    const { value, done } = await reader.read();
    if (done)
      throw new Error(`the server exited: ${output}${await new Response(server.stderr as ReadableStream).text()}`);
    output += decoder.decode(value);
  }
  const url = `http://127.0.0.1:${/PORT (\d+)/.exec(output)![1]}`;
  const call = (path: string, args: object = {}) => callAt(url, path, args);
  return { server, call };
}

async function callAt(url: string, path: string, args: object) {
  const t = performance.now();
  const body = (await (
    await fetch(`${url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    })
  ).json()) as { status: string; value?: unknown; errorMessage?: string };
  return { ...body, ms: performance.now() - t };
}

test("an exception thrown in a Node action's callback fails that action at once, alone", async () => {
  const { server, call } = await start();
  const [a, slow, b] = await Promise.all([
    call("n:callback", { tag: "a" }),
    call("n:slow"),
    call("n:callback", { tag: "b" }),
  ]);
  expect(a).toMatchObject({ status: "error", errorMessage: expect.stringContaining("uncaughtException: Yikes a") });
  expect(b).toMatchObject({ status: "error", errorMessage: expect.stringContaining("uncaughtException: Yikes b") });
  expect(a.ms).toBeLessThan(2000);
  expect(slow).toMatchObject({ status: "success", value: "slow" });
  expect(await call("n:timer")).toMatchObject({ errorMessage: expect.stringContaining("uncaughtException: late") });
  expect(await call("n:ok")).toMatchObject({ status: "success", value: "ok" });
  expect(server.exitCode).toBeNull();
});

test("process.exit in a Node action fails that action and never stops the server", async () => {
  const { server, call } = await start();
  expect(await call("n:exit", { code: 3 })).toMatchObject({
    status: "error",
    errorMessage: expect.stringContaining("process.exit: process.exit() called with exit code 3"),
  });
  expect(await call("n:exit", {})).toMatchObject({
    status: "error",
    errorMessage: expect.stringContaining("process.exit: process.exit() called with no exit code"),
  });
  // Caught by the action or not, the action failed: Convex's executor answers at the call.
  expect(await call("n:caught")).toMatchObject({
    status: "error",
    errorMessage: expect.stringContaining("process.exit() called with exit code 4"),
  });
  expect(await call("n:ok")).toMatchObject({ status: "success", value: "ok" });
  expect(server.exitCode).toBeNull();
});
