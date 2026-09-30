// The queries one `useQueries` call holds, as Convex's `react/queries_observer.ts`: a watch per identifier,
// replaced when its function or arguments change, and one listener for all of them.
import { type AnyFunctionReference, getFunctionName, type v1 } from "@bunvex/client";
import { toJsonValue, type Value } from "@bunvex/values";
import type { Watch } from "./client.ts";

export type RequestForQueries = Record<
  string,
  { query: AnyFunctionReference & { _type: "query" }; args: Record<string, Value> }
>;

export type CreateWatch = (
  query: AnyFunctionReference & { _type: "query" },
  args: Record<string, Value>,
  options: { journal?: v1.QueryJournal },
) => Watch<Value>;

type QueryInfo = {
  query: AnyFunctionReference & { _type: "query" };
  args: Record<string, Value>;
  watch: Watch<Value>;
  unsubscribe: () => void;
};

const sameArgs = (a: Record<string, Value>, b: Record<string, Value>) =>
  JSON.stringify(toJsonValue(a)) === JSON.stringify(toJsonValue(b));

export class QueriesObserver {
  private queries: Record<string, QueryInfo> = {};
  private listeners = new Set<() => void>();

  constructor(public createWatch: CreateWatch) {}

  /** Subscribe what is new, resubscribe what changed, drop what is gone. */
  setQueries(next: RequestForQueries) {
    for (const [id, { query, args }] of Object.entries(next)) {
      const existing = this.queries[id];
      if (existing === undefined) this.addQuery(id, query, args, {});
      else if (getFunctionName(query) !== getFunctionName(existing.query) || !sameArgs(args, existing.args)) {
        this.removeQuery(id);
        this.addQuery(id, query, args, {});
      }
    }
    for (const id of Object.keys(this.queries)) if (next[id] === undefined) this.removeQuery(id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Each query's local value: a value, undefined (loading) or its Error. */
  getLocalResults(queries: RequestForQueries): Record<string, Value | undefined | Error> {
    const result: Record<string, Value | undefined | Error> = {};
    for (const [id, { query, args }] of Object.entries(queries)) {
      const watch = this.createWatch(query, args, {});
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
    for (const [id, { query, args, watch }] of Object.entries(this.queries)) {
      const journal = watch.journal();
      this.removeQuery(id);
      this.addQuery(id, query, args, journal === undefined ? {} : { journal });
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
    options: { journal?: v1.QueryJournal },
  ) {
    if (this.queries[id] !== undefined)
      throw new Error(`Tried to add a new query with identifier ${id} when it already exists.`);
    const watch = this.createWatch(query, args, options);
    const unsubscribe = watch.onUpdate(() => {
      for (const l of this.listeners) l();
    });
    this.queries[id] = { query, args, watch, unsubscribe };
  }

  private removeQuery(id: string) {
    const info = this.queries[id];
    if (info === undefined) throw new Error(`No query found with identifier ${id}.`);
    info.unsubscribe();
    delete this.queries[id];
  }
}
