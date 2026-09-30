// Package @bunvex/client — the sync client (STUDY-26): one WebSocket that reconnects by itself, every
// subscription of the client advancing together, mutations that resolve once their write is visible, and
// optimistic updates. The counterpart of Convex's `convex/browser`.
export { anyApi, getFunctionName, makeFunctionReference } from "@bunvex/protocol";
export {
  BaseBunvexClient,
  type BaseBunvexClientOptions,
  type ConnectionState,
  type MutationOptions,
  type QueryModification,
  type SubscribeOptions,
  type Transition,
} from "./base-client.ts";
export type { FunctionFailure, FunctionResult, FunctionSuccess } from "./function-result.ts";
export type { Logger } from "./logging.ts";
export type { OptimisticLocalStore, OptimisticUpdate } from "./optimistic-updates.ts";
export { BunvexClient, type BunvexClientOptions, type Unsubscribe } from "./simple-client.ts";
export type { QueryToken } from "./udf-path.ts";
export { VERSION } from "./version.ts";
