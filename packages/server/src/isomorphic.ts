// `bunvex/server` outside Bun (STUDY-91): in a browser bundle and in Node (Next.js, Vite's server), as Convex's
// `convex/server`, which is the same module everywhere. Everything an app's code reaches through
// `bunvex/server` and its `_generated/` — the builders, the schema, function references, validators, the
// HTTP router, crons — and nothing of the runtime (the engine, persistence, the server), which needs Bun.
// package.json's `bun` condition gives Bun the whole package (./index.ts); every other runtime gets this.
// `isomorphic.test.ts` checks this file exports every value of ./index.ts not listed there as runtime-only.

import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";
import type { FunctionHandle } from "./function-handles.ts";

export { defineSchema, defineTable, docValidator } from "@bunvex/core/schema";
export { anyApi, getFunctionName, makeFunctionReference } from "@bunvex/protocol";
export {
  action,
  actionGeneric,
  internalAction,
  internalActionGeneric,
  internalMutation,
  internalMutationGeneric,
  internalQuery,
  internalQueryGeneric,
  mutation,
  mutationGeneric,
  query,
  queryGeneric,
} from "./builders.ts";
export { Crons, cronJobs } from "./cron.ts";
// Types: every type ./index.ts exports (erased from every bundle).
export type * from "./index.ts";
export { paginationOptsValidator, paginationResultValidator } from "./pagination.ts";
export { HttpRouter, httpAction, httpActionGeneric, httpRouter, ROUTABLE_HTTP_METHODS } from "./router.ts";

/**
 * Only a running function can make a handle: outside a backend this throws, as Convex's syscall does (the
 * reference is checked first, as Convex's `getFunctionAddress`).
 */
export async function createFunctionHandle(ref: AnyFunctionReference): Promise<FunctionHandle> {
  getFunctionName(ref);
  throw new Error(
    "The bunvex database and auth objects are being used outside of a bunvex backend. " +
      "Did you mean to use `useQuery` or `useMutation` to call a bunvex function?",
  );
}
