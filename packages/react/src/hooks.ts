// The hooks, as Convex's `react/client.ts` and `react/use_queries.ts`: `useQuery` (and `"skip"`),
// `useQueries`, `useMutation` (with `withOptimisticUpdate`), `useAction` and the connection state. Every
// query of one component tree changes in the same render, since one transition notifies them together.
import {
  type AnyFunctionReference,
  type ConnectionState,
  type EmptyObject,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
} from "@bunvex/client";
import { isSimpleObject, toJsonValue, type Value } from "@bunvex/values";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createAction, createMutation, type ReactAction, type ReactMutation } from "./client.ts";
import { useRequiredClient } from "./context.ts";
import { type CreateWatch, QueriesObserver, type RequestForQueries } from "./queries-observer.ts";
import { useSubscription } from "./use-subscription.ts";

type Ref<T extends "query" | "mutation" | "action"> = AnyFunctionReference & { _type: T };

/** `[args?]` or `[args | "skip"]`: `"skip"` renders `undefined` without subscribing. */
export type OptionalRestArgsOrSkip<F extends AnyFunctionReference> =
  FunctionArgs<F> extends EmptyObject ? [args?: EmptyObject | "skip"] : [args: FunctionArgs<F> | "skip"];

export type UseQueryResult<T, ThrowOnError extends boolean = false> =
  | { status: "pending" }
  | { status: "success"; data: T }
  | (ThrowOnError extends true ? never : { status: "error"; error: Error });

function parseArgs(args: unknown): Record<string, Value> {
  if (args === undefined) return {};
  if (!isSimpleObject(args))
    throw new Error(`The arguments to a bunvex function must be an object. Received: ${args as string}`);
  return args as Record<string, Value>;
}

const asRef = <T extends "query" | "mutation" | "action">(f: Ref<T> | string): Ref<T> =>
  typeof f === "string" ? (makeFunctionReference<T>(f) as unknown as Ref<T>) : f;

/** Several queries at once, by identifier: each result is its value, `undefined` (loading) or its Error. */
export function useQueries(queries: RequestForQueries): Record<string, unknown> {
  const client = useRequiredClient("useQuery");
  const createWatch = useMemo<CreateWatch>(
    () =>
      (query, args, { journal, paginationOptions }) =>
        paginationOptions !== undefined
          ? client.watchPaginatedQuery(query, args, paginationOptions)
          : client.watchQuery(query, args, journal ? { journal } : {}),
    [client],
  );
  const [observer] = useState(() => new QueriesObserver(createWatch));
  if (observer.createWatch !== createWatch) observer.setCreateWatch(createWatch);
  useEffect(() => () => observer.destroy(), [observer]);
  const subscription = useMemo(
    () => ({
      getCurrentValue: () => observer.getLocalResults(queries),
      subscribe: (callback: () => void) => {
        observer.setQueries(queries);
        return observer.subscribe(callback);
      },
    }),
    [observer, queries],
  );
  return useSubscription(subscription);
}

function useOneQuery(query: Ref<"query"> | string, args: unknown): unknown {
  const skip = args === "skip";
  const argsObject = skip ? {} : parseArgs(args);
  const ref = asRef<"query">(query);
  const name = getFunctionName(ref);
  const argsKey = JSON.stringify(toJsonValue(argsObject));
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the function's name and its args' JSON
  const queries = useMemo<RequestForQueries>(
    () => (skip ? ({} as RequestForQueries) : { query: { query: ref, args: argsObject } }),
    [argsKey, name, skip],
  );
  return useQueries(queries).query;
}

/**
 * A query's current result, kept up to date: `undefined` while loading, and a failed query throws its error
 * (to the nearest error boundary). Pass `"skip"` as the arguments to not run it.
 */
export function useQuery<Q extends Ref<"query">>(
  query: Q | string,
  ...args: OptionalRestArgsOrSkip<Q>
): FunctionReturnType<Q> | undefined {
  const result = useOneQuery(query, args[0]);
  if (result instanceof Error) throw result;
  return result as FunctionReturnType<Q> | undefined;
}

/** The object form: `{status: "pending" | "success" | "error"}`; errors are returned unless `throwOnError`. */
export function useQuery_experimental<Q extends Ref<"query">, ThrowOnError extends boolean = false>(options: {
  query: Q | string;
  args: FunctionArgs<Q> | "skip";
  throwOnError?: ThrowOnError;
}): UseQueryResult<FunctionReturnType<Q>, ThrowOnError> {
  const result = useOneQuery(options.query, options.args);
  if (result instanceof Error) {
    if (options.throwOnError) throw result;
    return { status: "error", error: result } as UseQueryResult<FunctionReturnType<Q>, ThrowOnError>;
  }
  if (result === undefined) return { status: "pending" };
  return { status: "success", data: result as FunctionReturnType<Q> };
}

/** A mutation as a stable function; `.withOptimisticUpdate(fn)` adds an optimistic update. */
export function useMutation<M extends Ref<"mutation">>(mutation: M | string): ReactMutation<M> {
  const ref = asRef<"mutation">(mutation) as M;
  const client = useRequiredClient("useMutation");
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable per client and function name
  return useMemo(() => createMutation(ref, client), [client, getFunctionName(ref)]);
}

/** An action as a stable function. */
export function useAction<A extends Ref<"action">>(action: A | string): ReactAction<A> {
  const ref = asRef<"action">(action) as A;
  const client = useRequiredClient("useAction");
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable per client and function name
  return useMemo(() => createAction(ref, client), [client, getFunctionName(ref)]);
}

/** The connection state, re-rendering when it changes. */
export function useBunvexConnectionState(): ConnectionState {
  const client = useRequiredClient("useBunvexConnectionState");
  const getCurrentValue = useCallback(() => client.connectionState(), [client]);
  const subscribe = useCallback(
    (callback: () => void) => client.subscribeToConnectionState(() => callback()),
    [client],
  );
  return useSubscription({ getCurrentValue, subscribe });
}
