// Package @bunvex/server — the function runtime, the transports (HTTP + WebSocket sync) and configuration.
export { defineSchema, defineTable } from "@bunvex/core";
// Function references, as Convex's `convex/server` exports them (STUDY-26 C3).
export {
  type AnyApi,
  anyApi,
  type FunctionReference,
  getFunctionName,
  makeFunctionReference,
} from "@bunvex/protocol";
export {
  type ActionCtx,
  type ArgsOf,
  type ArgsValidator,
  action,
  type FunctionDef,
  Functions,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./functions.ts";
export { paginationOptsValidator, paginationResultValidator } from "./pagination.ts";
export { openPersistence, type PersistenceConfig, persistenceConfigFromEnv } from "./persistence.ts";
export { createServer, type ServerOptions } from "./server.ts";
