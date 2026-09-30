// Package @bunvex/react — React bindings (STUDY-26 §7), the counterpart of Convex's `convex/react`:
// `BunvexReactClient` shared through `BunvexProvider`, and the hooks.
export {
  type BaseClientInterface,
  BunvexReactClient,
  type BunvexReactClientOptions,
  type MutationOptions,
  type ReactAction,
  type ReactMutation,
  type Watch,
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
export { useSubscription } from "./use-subscription.ts";
