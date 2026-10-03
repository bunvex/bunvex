// The queries one `useQueries` call holds, as Convex's `react/queries_observer.ts`: a watch per identifier,
// replaced when its function, arguments or pagination options change, and one listener for all of them. A
// query with `paginationOptions` is a paginated query (`watchPaginatedQuery`): its value is the loaded pages
// as one list.
import {
  type AnyFunctionReference,
  getFunctionName,
  type SubscribeToPaginatedQueryOptions,
  type v1,
} from "@bunvex/client";
import { toJsonValue, type Value } from "@bunvex/values";
import type { PaginatedWatch, Watch } from "./client.ts";

export type RequestForQueries = Record<
  string,
  {
    query: AnyFunctionReference & { _type: "query" };
    args: Record<string, Value>;
    /** @internal A paginated query: `args` without `paginationOpts`. */
    paginationOptions?: SubscribeToPaginatedQueryOptions;
  }
>;

export type CreateWatch = (
  query: AnyFunctionReference & { _type: "query" },
  args: Record<string, Value>,
  options: { journal?: v1.QueryJournal; paginationOptions?: SubscribeToPaginatedQueryOptions },
) => Watch<Value> | PaginatedWatch<Value>;

type QueryInfo = {
  query: AnyFunctionReference & { _type: "query" };
  args: Record<string, Value>;
  paginationOptions: SubscribeToPaginatedQueryOptions | undefined;
  watch: Watch<Value> | PaginatedWatch<Value>;
  unsubscribe: () => void;
};

const sameArgs = (a: Record<string, Value>, b: Record<string, Value>) =>
  JSON.stringify(toJsonValue(a)) === JSON.stringify(toJsonValue(b));

const withPagination = (paginationOptions: SubscribeToPaginatedQueryOptions | undefined) =>
  paginationOptions === undefined ? {} : { paginationOptions };

export class QueriesObserver {
  private queries: Record<string, QueryInfo> = {};
  private listeners = new Set<() => void>();

  constructor(public createWatch: CreateWatch) {}

  /** Subscribe what is new, resubscribe what changed, drop what is gone. */
  setQueries(next: RequestForQueries) {
    for (const [id, { query, args, paginationOptions }] of Object.entries(next)) {
      const existing = this.queries[id];
      if (existing === undefined) this.addQuery(id, query, args, withPagination(paginationOptions));
      else if (
        getFunctionName(query) !== getFunctionName(existing.query) ||
        !sameArgs(args, existing.args) ||
        JSON.stringify(paginationOptions) !== JSON.stringify(existing.paginationOptions)
      ) {
        this.removeQuery(id);
        this.addQuery(id, query, args, withPagination(paginationOptions));
      }
    }
    for (const id of Object.keys(this.queries)) if (next[id] === undefined) this.removeQuery(id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Each query's local value: a value (a paginated query's result), undefined (loading) or its Error. */
  getLocalResults(queries: RequestForQueries): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [id, { query, args, paginationOptions }] of Object.entries(queries)) {
      const watch = this.createWatch(query, args, withPagination(paginationOptions));
      try {
        result[id] = watch.localQueryResult();
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        result[id] = e;
      }
    }
    return result;
  }

  /** A new client: move every query over, with its journal. */
  setCreateWatch(createWatch: CreateWatch) {
    this.createWatch = createWatch;
    for (const [id, { query, args, watch, paginationOptions }] of Object.entries(this.queries)) {
      const journal = "journal" in watch ? watch.journal() : undefined;
      this.removeQuery(id);
      this.addQuery(id, query, args, {
        ...(journal === undefined ? {} : { journal }),
        ...withPagination(paginationOptions),
      });
    }
  }

  destroy() {
    for (const id of Object.keys(this.queries)) this.removeQuery(id);
    this.listeners = new Set();
  }

  private addQuery(
    id: string,
    query: AnyFunctionReference & { _type: "query" },
    args: Record<string, Value>,
    options: { journal?: v1.QueryJournal; paginationOptions?: SubscribeToPaginatedQueryOptions },
  ) {
    if (this.queries[id] !== undefined)
      throw new Error(`Tried to add a new query with identifier ${id} when it already exists.`);
    const watch = this.createWatch(query, args, options);
    const unsubscribe = watch.onUpdate(() => {
      for (const l of this.listeners) l();
    });
    this.queries[id] = { query, args, paginationOptions: options.paginationOptions, watch, unsubscribe };
  }

  private removeQuery(id: string) {
    const info = this.queries[id];
    if (info === undefined) throw new Error(`No query found with identifier ${id}.`);
    info.unsubscribe();
    delete this.queries[id];
  }
}
