// Preloaded to run a suite's servers under the `process` executor (STUDY-171 §8.9, the parity runs):
//
//   BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none \
//     bun test --preload ./packages/sandbox/test/process-preload.ts packages/server/test/push.test.ts
//
// It provides the executor, as `bunvex-local-backend` does; every `createServer` that reads the variables then runs
// its pushed queries and mutations in a child.
import { provideProcessExecutor } from "@bunvex/server/executor";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);
