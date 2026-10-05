// Package @bunvex/client — the sync client (STUDY-26): one WebSocket that reconnects by itself, every
// subscription of the client advancing together, mutations that resolve once their write is visible, and
// optimistic updates. The counterpart of Convex's `convex/browser`.
export {
  type AnyApi,
  type AnyFunctionReference,
  type ArgsAndOptions,
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
/**
 * @internal The logger factories, for `@bunvex/react`: Convex's React client builds its logger with them, and
 * they live in the same package there (`browser/logging.ts`). Not part of Convex's public API.
 */
export { instantiateDefaultLogger, instantiateNoopLogger } from "./logging.ts";
export type { OptimisticLocalStore, OptimisticUpdate } from "./optimistic-updates.ts";
export {
  type ExtendedTransition,
  type PaginatedBaseClient,
  PaginatedQueryClient,
  type PaginatedQueryModification,
  type SubscribeToPaginatedQueryOptions,
} from "./paginated-query-client.ts";
export {
  asPaginationResult,
  type LoadMoreOfPaginatedQuery,
  type PaginatedQueryResult,
  type PaginationOptions,
  type PaginationResult,
  type PaginationStatus,
} from "./pagination.ts";
/** @internal `bunvexQueryOptions`, as Convex's `convexQueryOptions` (DV-348); `QueryOptions` is public. */
export { bunvexQueryOptions, type QueryOptions } from "./query-options.ts";
export { BunvexClient, type BunvexClientOptions, type Unsubscribe } from "./simple-client.ts";
export type { PaginatedQueryToken, QueryToken } from "./udf-path.ts";
export { VERSION } from "./version.ts";
