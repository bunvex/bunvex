// Package @bunvex/client — the sync client (STUDY-26): one WebSocket that reconnects by itself, every
// subscription of the client advancing together, mutations that resolve once their write is visible, and
// optimistic updates. The counterpart of Convex's `convex/browser`.
export {
  type AnyApi,
  type AnyFunctionReference,
  anyApi,
  type EmptyObject,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
  type OptionalRestArgs,
  v1,
} from "@bunvex/protocol";
export type { AuthTokenFetcher } from "./authentication-manager.ts";
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
export {
  BunvexHttpClient,
  type FetchOptions,
  type HttpMutationOptions,
  STATUS_CODE_BAD_REQUEST,
  STATUS_CODE_OK,
  STATUS_CODE_UDF_FAILED,
  setFetch,
} from "./http-client.ts";
export type { Logger } from "./logging.ts";
export type { OptimisticLocalStore, OptimisticUpdate } from "./optimistic-updates.ts";
export {
  asPaginationResult,
  type PaginationOptions,
  type PaginationResult,
  type PaginationStatus,
} from "./pagination.ts";
export { BunvexClient, type BunvexClientOptions, type Unsubscribe } from "./simple-client.ts";
export type { QueryToken } from "./udf-path.ts";
export { VERSION } from "./version.ts";
