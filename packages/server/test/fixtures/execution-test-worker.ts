// An execution worker for `execution-workers.test.ts`: the protocol's runtime with calls that misbehave on demand.
// A call's text names what it does: `echo:<text>`, `whoami` (the worker's thread id), `wait:<ms>` (an idle wait),
// `busy:<ms>` (resumes on microtasks only, marking progress each time, as a query whose store reads are synchronous),
// `spin` (`for (;;) {}`), `await-spin` (`for (;;) await null`), `exit`, `throw` (an uncaught error), `reject` (the
// call fails in the worker).
// `heard` (the other messages heard since the last `heard`), `ask:<text>` (an op). An init text of `fail` fails
// the start; `hang` never answers it; `slow` answers after 150 ms.
import { threadId } from "node:worker_threads";
import { ask, running, serveExecutionThread } from "../../src/execution-thread.ts";

/** The other messages heard, in order: made by `init`, as a worker's state is (none before it). */
let heard: string[] | null = null;

serveExecutionThread({
  async init(text) {
    if (text === "slow") await Bun.sleep(150);
    heard = [];
    if (text === "fail") throw new Error("cannot open the store");
    if (text === "hang") await new Promise(() => {});
  },
  message(text) {
    heard!.push(text);
  },
  async call(id, text) {
    const [what, arg = ""] = text.split(/:(.*)/s);
    switch (what) {
      case "echo":
        return arg;
      case "whoami":
        return String(threadId);
      case "heard":
        return heard!.splice(0).join(",");
      case "ask":
        return `answered ${await ask(arg)}`;
      case "wait":
        await Bun.sleep(Number(arg));
        return "waited";
      case "busy": {
        const end = performance.now() + Number(arg);
        while (performance.now() < end) {
          await null;
          running(id);
        }
        return "busy";
      }
      case "spin":
        for (;;) {}
      case "await-spin":
        for (;;) await null;
      case "exit":
        process.exit(7);
        break;
      case "throw":
        setTimeout(() => {
          throw new Error("an uncaught error");
        });
        return new Promise(() => {});
      case "reject":
        throw new Error("no such call");
    }
    throw new Error(`unknown call ${text}`);
  },
});
