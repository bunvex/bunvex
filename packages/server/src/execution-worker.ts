// The execution worker module (STUDY-194 §4, STUDY-190 PR 2): what `ExecutionWorkers` starts in each Bun Worker.
// `scripts/build-binary.ts` embeds it in `bunvex-local-backend` as an entry point of its own. It opens nothing and
// runs no call yet: its store reader, the code versions and the calls are wired by the PRs that dispatch to it
// (STUDY-194 §10.5, ii–iv); until then no server starts it.
import { serveExecutionThread } from "./execution-thread.ts";

serveExecutionThread({
  init() {},
  call: () => Promise.reject(new Error("this execution worker runs no calls yet")),
});
