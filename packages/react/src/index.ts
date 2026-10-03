// Package @bunvex/react — React bindings (STUDY-26 §7), the counterpart of Convex's `convex/react`:
// `BunvexReactClient` shared through `BunvexProvider`, the hooks, and auth (`BunvexProviderWithAuth`).

export {
  Authenticated,
  AuthLoading,
  AuthRefreshing,
  type BunvexAuthState,
  BunvexProviderWithAuth,
  Unauthenticated,
  useBunvexAuth,
} from "./auth.ts";
export {
  type BaseClientInterface,
  BunvexReactClient,
  type BunvexReactClientOptions,
  type MutationOptions,
  type PaginatedWatch,
  type ReactAction,
  type ReactMutation,
  type Watch,
  type WatchPaginatedQueryOptions,
  type WatchQueryOptions,
} from "./client.ts";
export { BunvexProvider, useBunvex } from "./context.ts";
export {
  type OptionalRestArgsOrSkip,
  type UseQueryResult,
  useAction,
  useBunvexConnectionState,
  useMutation,
  useQueries,
  useQuery,
  useQuery_experimental,
} from "./hooks.ts";
export type { RequestForQueries } from "./queries-observer.ts";
export {
  insertAtBottomIfLoaded,
  insertAtPosition,
  insertAtTop,
  optimisticallyUpdateValueInPaginatedQuery,
  type PaginatedQueryArgs,
  type PaginatedQueryItem,
  type PaginatedQueryReference,
  resetPaginationId,
  type UsePaginatedQueryResult,
  usePaginatedQuery,
} from "./use-paginated-query.ts";
export {
  type UsePaginatedQueryObjectReturnType,
  type UsePaginatedQueryOptions,
  usePaginatedQuery_experimental,
} from "./use-paginated-query2.ts";
export { useSubscription } from "./use-subscription.ts";
