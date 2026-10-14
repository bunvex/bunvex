// A "use node" action's process-level failures (platform §9), as Convex's Node executor answers them
// (npm-packages/node-executor/src/executor.ts `unhandledRejectionHandler`): an exception thrown in one of the
// action's callbacks (`uncaughtException`) or a call to `process.exit` fails the action at once, as an error named
// after the event, with the app's frames of the throw or the call. Convex's executor then exits its own process;
// bunvex runs Node actions in its process (DV-87), so the action fails and the server goes on.
//
// Which action an exception belongs to is the async context it was thrown in: Bun keeps the AsyncLocalStorage
// store in a process `uncaughtException` listener. The listener is attached only while a Node action runs; an
// exception then thrown outside any ends the process, as without the listener. An unhandled rejection has no
// such context in Bun, so it is left as before: printed, and the action goes on.
import { AsyncLocalStorage } from "node:async_hooks";

/** The error a Node action fails with: named after the event, with `e`'s message and frames. */
function processError(event: "uncaughtException" | "process.exit", e: unknown): Error {
  const message = typeof e === "object" && e !== null && "message" in e ? String((e as Error).message) : String(e);
  const stack =
    typeof e === "object" && e !== null && typeof (e as Error).stack === "string" ? (e as Error).stack! : "";
  const err = new Error(message);
  err.name = event;
  err.stack = [`${event}: ${message}`, ...stack.split("\n").filter((l) => /^\s+at /.test(l))].join("\n");
  return err;
}

/** The running Node action's way to fail at once. */
const owners = new AsyncLocalStorage<(e: Error) => void>();
let running = 0;

function onUncaught(e: unknown) {
  const fail = owners.getStore();
  if (fail) return fail(processError("uncaughtException", e));
  // Outside any Node action, as Bun without a listener: the error printed, the process ended.
  console.error(e);
  process.exit(1);
}

/**
 * Run a Node action's body: it settles as the body does, or fails at once with an exception thrown in one of its
 * callbacks, or with its `process.exit` call (`nodeProcessExit`).
 */
export function withNodeProcessErrors<T>(body: () => Promise<T>): Promise<T> {
  if (running++ === 0) process.on("uncaughtException", onUncaught);
  return new Promise<T>((resolve, reject) => {
    owners.run(reject, body).then(resolve, reject);
  }).finally(() => {
    if (--running === 0) process.off("uncaughtException", onUncaught);
  });
}

/**
 * `process.exit` in a Node action's context: the action fails with Convex's message, and the call throws so the
 * code after it does not run. The server never exits.
 */
export function nodeProcessExit(code?: number | string | null): never {
  const e = processError(
    "process.exit",
    new Error(`process.exit() called ${code === undefined ? "with no exit code" : `with exit code ${code}`}`),
  );
  owners.getStore()?.(e);
  throw e;
}
