// Optimistic updates, as Convex's `sync/optimistic_updates.ts` and `optimistic_updates_impl.ts`: the view of
// query results the app sees is the server's results with every pending optimistic update applied on top,
// in order. Each server transition rebuilds the view from scratch; an update is dropped once its mutation is
// reflected in the server's results (or failed), so the server's value replaces the guess without flicker.
import {
  type AnyFunctionReference,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  type OptionalRestArgs,
  type v1,
} from "@bunvex/protocol";
import type { Value } from "@bunvex/values";
import { parseArgs } from "./args.ts";
import type { FunctionResult } from "./function-result.ts";
import { errorFor } from "./logging.ts";
import { canonicalizeUdfPath, type QueryToken, serializePathAndArgs } from "./udf-path.ts";

type QueryRef = AnyFunctionReference & { _type: "query" };

/** What an optimistic update reads and writes: the client's current query results. */
export interface OptimisticLocalStore {
  /** A query's current value; `undefined` while loading, or when it failed. */
  getQuery<Q extends QueryRef>(query: Q, ...args: OptionalRestArgs<Q>): undefined | FunctionReturnType<Q>;
  /** Every loaded query of this function, with its arguments. */
  getAllQueries<Q extends QueryRef>(query: Q): { args: FunctionArgs<Q>; value: undefined | FunctionReturnType<Q> }[];
  /** Set a query's value (`undefined`: show it as loading) until the mutation is reflected. */
  setQuery<Q extends QueryRef>(query: Q, args: FunctionArgs<Q>, value: undefined | FunctionReturnType<Q>): void;
}

export type OptimisticUpdate<Args extends Record<string, Value>> = (
  localQueryStore: OptimisticLocalStore,
  args: Args,
) => void;

type WrappedOptimisticUpdate = (store: OptimisticLocalStore) => void;

/** A result, or `undefined` when an optimistic update set the query loading. */
type Query = { result: FunctionResult | undefined; udfPath: string; args: Record<string, Value> };
export type QueryResultsMap = Map<QueryToken, Query>;

const resultValue = (result: FunctionResult | undefined): Value | undefined =>
  // A failed query reads as loading: one errored query must not break the whole update.
  result?.success ? result.value : undefined;

class OptimisticLocalStoreImpl implements OptimisticLocalStore {
  readonly modifiedQueries: QueryToken[] = [];
  constructor(private readonly queryResults: QueryResultsMap) {}

  getQuery<Q extends QueryRef>(query: Q, ...args: OptionalRestArgs<Q>): undefined | FunctionReturnType<Q> {
    const token = serializePathAndArgs(getFunctionName(query), parseArgs(args[0] as Record<string, Value>));
    const q = this.queryResults.get(token);
    return q === undefined ? undefined : (resultValue(q.result) as FunctionReturnType<Q>);
  }

  getAllQueries<Q extends QueryRef>(query: Q): { args: FunctionArgs<Q>; value: undefined | FunctionReturnType<Q> }[] {
    const path = canonicalizeUdfPath(getFunctionName(query));
    const out: { args: FunctionArgs<Q>; value: undefined | FunctionReturnType<Q> }[] = [];
    for (const q of this.queryResults.values())
      if (q.udfPath === path)
        out.push({ args: q.args as FunctionArgs<Q>, value: resultValue(q.result) as FunctionReturnType<Q> });
    return out;
  }

  setQuery<Q extends QueryRef>(query: Q, args: FunctionArgs<Q>, value: undefined | FunctionReturnType<Q>): void {
    const queryArgs = parseArgs(args as Record<string, Value>);
    const name = getFunctionName(query);
    const token = serializePathAndArgs(name, queryArgs);
    // An optimistic value has no function logs.
    const result: FunctionResult | undefined =
      value === undefined ? undefined : { success: true, value: value as Value, logLines: [] };
    this.queryResults.set(token, { udfPath: canonicalizeUdfPath(name), args: queryArgs, result });
    this.modifiedQueries.push(token);
  }
}

/** All query results, with the pending optimistic updates applied. */
export class OptimisticQueryResults {
  private queryResults: QueryResultsMap = new Map();
  private optimisticUpdates: { update: WrappedOptimisticUpdate; mutationId: v1.RequestId }[] = [];

  /** New server results: drop the updates of reflected mutations, re-apply the rest; the queries that changed. */
  ingestQueryResultsFromServer(serverQueryResults: QueryResultsMap, toDrop: Set<v1.RequestId>): QueryToken[] {
    this.optimisticUpdates = this.optimisticUpdates.filter((u) => !toDrop.has(u.mutationId));
    const old = this.queryResults;
    this.queryResults = new Map(serverQueryResults);
    const store = new OptimisticLocalStoreImpl(this.queryResults);
    for (const u of this.optimisticUpdates) u.update(store);
    // A shallow compare: a query changed when its result object did (as Convex).
    const changed: QueryToken[] = [];
    for (const [token, q] of this.queryResults)
      if (old.get(token)?.result !== q.result || !old.has(token)) changed.push(token);
    return changed;
  }

  applyOptimisticUpdate(update: WrappedOptimisticUpdate, mutationId: v1.RequestId): QueryToken[] {
    this.optimisticUpdates.push({ update, mutationId });
    const store = new OptimisticLocalStoreImpl(this.queryResults);
    update(store);
    return store.modifiedQueries;
  }

  /** The result, errors included (not thrown), optimistic updates applied. */
  rawQueryResult(token: QueryToken): FunctionResult | undefined {
    return this.queryResults.get(token)?.result;
  }

  /** The value; a failed query throws its error, as the app would see it. */
  queryResult(token: QueryToken): Value | undefined {
    const q = this.queryResults.get(token);
    if (q?.result === undefined) return undefined;
    if (q.result.success) return q.result.value;
    throw errorFor("query", q.udfPath, q.result);
  }

  hasQueryResult(token: QueryToken): boolean {
    return this.queryResults.get(token) !== undefined;
  }

  queryLogs(token: QueryToken): string[] | undefined {
    return this.queryResults.get(token)?.result?.logLines;
  }
}
