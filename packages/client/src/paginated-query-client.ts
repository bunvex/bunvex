// The paginated query client, as Convex's `browser/sync/paginated_query_client.ts` (STUDY-26 §8.4): one
// subscription per paginated query, kept as an ordered list of page queries on the base client.
// - The first page starts at `cursor: null`; `loadMore(n)` adds a page at the last page's `continueCursor`.
// - A page the server says is too large (`SplitRecommended` / `SplitRequired`), or with more than twice
//   `initialNumItems`, is split in two at its `splitCursor`; the halves replace it once both have loaded.
// - Every base transition goes through here first, so the paginated queries it touched are reported in the
//   same synchronous call as the plain ones (`ExtendedTransition`).
// - A page that failed makes `localQueryResultByToken` throw, for the caller to report; it never escapes the
//   transition itself (DV-250: in Convex the error is thrown out of the transition handler).
import type { Value } from "@bunvex/values";
import type { Transition } from "./base-client.ts";
import { asPaginationResult, type PaginatedQueryResult, type PaginationStatus } from "./pagination.ts";
import {
  canonicalizeUdfPath,
  type PaginatedQueryToken,
  type QueryToken,
  serializePaginatedPathAndArgs,
} from "./udf-path.ts";

/** What this client needs from the base client. */
export type PaginatedBaseClient = {
  subscribe(name: string, args?: Record<string, Value>): { queryToken: QueryToken; unsubscribe: () => void };
  localQueryResultByToken(queryToken: QueryToken): Value | undefined;
  addOnTransitionHandler(fn: (transition: Transition) => void): () => void;
};

export type SubscribeToPaginatedQueryOptions = { initialNumItems: number; id: number };

export type PaginatedQueryModification =
  | { kind: "Updated"; result: PaginatedQueryResult<Value> | undefined }
  | { kind: "Removed" };

/** A base transition, plus the paginated queries it changed. */
export type ExtendedTransition = Transition & {
  paginatedQueries: { token: PaginatedQueryToken; modification: PaginatedQueryModification }[];
};

type PageKey = number;
type Page = { queryToken: QueryToken; unsubscribe: () => void; cursor: string | null };

type PaginatedQuery = {
  udfPath: string;
  /** Without `paginationOpts`. */
  args: Record<string, Value>;
  initialNumItems: number;
  /** Sent in every page's `paginationOpts`: separate uses of one query never share a page. */
  id: number;
  subscribers: number;
  nextPageKey: PageKey;
  /** The pages that make up the results, in order, with no gap. */
  pageKeys: PageKey[];
  /** Every page subscribed: the active ones and the halves of ongoing splits. */
  pages: Map<PageKey, Page>;
  /** A page being split, and its two halves (not active until both have loaded). */
  ongoingSplits: Map<PageKey, [PageKey, PageKey]>;
};

export class PaginatedQueryClient {
  private readonly queries = new Map<PaginatedQueryToken, PaginatedQuery>();
  /** The last base transition's timestamp, for the transitions `loadMore` makes. */
  private lastTimestamp = 0n;

  constructor(
    private readonly client: PaginatedBaseClient,
    private readonly onTransition: (transition: ExtendedTransition) => void,
  ) {
    client.addOnTransitionHandler((t) => this.onBaseTransition(t));
  }

  /** Subscribe to a paginated query (`args` without `paginationOpts`); equal subscriptions share one. */
  subscribe(
    name: string,
    args: Record<string, Value>,
    options: SubscribeToPaginatedQueryOptions,
  ): { paginatedQueryToken: PaginatedQueryToken; unsubscribe: () => void } {
    const udfPath = canonicalizeUdfPath(name);
    const token = serializePaginatedPathAndArgs(udfPath, args, options);
    const unsubscribe = () => this.removeSubscriber(token);
    const existing = this.queries.get(token);
    if (existing) {
      existing.subscribers++;
      return { paginatedQueryToken: token, unsubscribe };
    }
    this.queries.set(token, {
      udfPath,
      args,
      initialNumItems: options.initialNumItems,
      id: options.id,
      subscribers: 1,
      nextPageKey: 0,
      pageKeys: [],
      pages: new Map(),
      ongoingSplits: new Map(),
    });
    this.addPage(token, null, options.initialNumItems);
    return { paginatedQueryToken: token, unsubscribe };
  }

  /** The current result by name and arguments; throws when a page failed. */
  localQueryResult(
    name: string,
    args: Record<string, Value>,
    options: SubscribeToPaginatedQueryOptions,
  ): PaginatedQueryResult<Value> | undefined {
    return this.localQueryResultByToken(serializePaginatedPathAndArgs(canonicalizeUdfPath(name), args, options));
  }

  /** The current result; `undefined` when not subscribed; throws when a page failed. */
  localQueryResultByToken(token: PaginatedQueryToken): PaginatedQueryResult<Value> | undefined {
    const q = this.queries.get(token);
    if (q === undefined) return undefined;
    const loadMore = (numItems: number) => this.loadMore(token, numItems);
    if (q.pageKeys.length === 0) return { results: [], status: "LoadingFirstPage", loadMore };
    const results: Value[] = [];
    let loading = false;
    let isDone = false;
    for (const key of q.pageKeys) {
      const value = this.client.localQueryResultByToken(this.page(q, key).queryToken);
      if (value === undefined) {
        loading = true;
        isDone = false;
        continue;
      }
      const page = asPaginationResult(value);
      results.push(...page.page);
      isDone = page.isDone; // only the last page's matters
    }
    const status: PaginationStatus = loading
      ? results.length === 0
        ? "LoadingFirstPage"
        : "LoadingMore"
      : isDone
        ? "Exhausted"
        : "CanLoadMore";
    return { results, status, loadMore };
  }

  private onBaseTransition(transition: Transition) {
    this.lastTimestamp = transition.timestamp;
    const changed = this.queriesContaining(new Set(transition.queries.map((q) => q.token)));
    for (const token of changed) this.processSplits(this.mustGet(token));
    this.onTransition({
      ...transition,
      paginatedQueries: changed.map((token) => ({ token, modification: this.updated(token) })),
    });
  }

  private updated(token: PaginatedQueryToken): PaginatedQueryModification {
    let result: PaginatedQueryResult<Value> | undefined;
    try {
      result = this.localQueryResultByToken(token);
    } catch {
      result = undefined; // a failed page: readers get the error from `localQueryResultByToken`
    }
    return { kind: "Updated", result };
  }

  /** A page's value, or undefined while loading or when it failed (no split is decided on an error). */
  private loadedValue(queryToken: QueryToken): Value | undefined {
    try {
      return this.client.localQueryResultByToken(queryToken);
    } catch {
      return undefined;
    }
  }

  /** Always reports a transition when it starts a page: the status went from CanLoadMore to LoadingMore. */
  private loadMore(token: PaginatedQueryToken, numItems: number): boolean {
    const q = this.mustGet(token);
    const lastKey = q.pageKeys[q.pageKeys.length - 1];
    if (lastKey === undefined) throw new Error(`No pages for paginated query ${token}`);
    const last = this.client.localQueryResultByToken(this.page(q, lastKey).queryToken);
    if (last === undefined) return false; // the last page is still loading: one load at a time
    const page = asPaginationResult(last);
    if (page.isDone) return false;
    this.addPage(token, page.continueCursor, numItems);
    this.onTransition({
      queries: [],
      reflectedMutations: [],
      timestamp: this.lastTimestamp,
      paginatedQueries: [{ token, modification: this.updated(token) }],
    });
    return true;
  }

  private queriesContaining(tokens: Set<QueryToken>): PaginatedQueryToken[] {
    if (tokens.size === 0) return [];
    const changed: PaginatedQueryToken[] = [];
    for (const [token, q] of this.queries)
      for (const page of q.pages.values())
        if (tokens.has(page.queryToken)) {
          changed.push(token);
          break;
        }
    return changed;
  }

  private processSplits(q: PaginatedQuery) {
    for (const [key, [first, second]] of q.ongoingSplits)
      if (
        this.loadedValue(this.page(q, first).queryToken) !== undefined &&
        this.loadedValue(this.page(q, second).queryToken) !== undefined
      )
        this.completeSplit(q, key, first, second);
    for (const key of q.pageKeys) {
      if (q.ongoingSplits.has(key)) continue;
      const entry = this.page(q, key);
      const value = this.loadedValue(entry.queryToken);
      if (value === undefined) continue;
      const page = asPaginationResult(value);
      if (
        page.splitCursor &&
        (page.pageStatus === "SplitRecommended" ||
          page.pageStatus === "SplitRequired" ||
          page.page.length > q.initialNumItems * 2)
      )
        this.split(q, key, entry.cursor, page.splitCursor, page.continueCursor);
    }
  }

  /** Subscribe to the two halves of page `key`: `[start, splitCursor)` and `[splitCursor, end)`. */
  private split(q: PaginatedQuery, key: PageKey, start: string | null, splitCursor: string, end: string | null) {
    const first = q.nextPageKey++;
    const second = q.nextPageKey++;
    const half = (cursor: string | null, endCursor: string | null): Page => ({
      ...this.client.subscribe(q.udfPath, {
        ...q.args,
        paginationOpts: { numItems: q.initialNumItems, id: q.id, cursor, endCursor },
      }),
      cursor,
    });
    q.pages.set(first, half(start, splitCursor));
    q.pages.set(second, half(splitCursor, end));
    q.ongoingSplits.set(key, [first, second]);
  }

  private completeSplit(q: PaginatedQuery, key: PageKey, first: PageKey, second: PageKey) {
    const original = this.page(q, key);
    q.pages.delete(key);
    q.pageKeys.splice(q.pageKeys.indexOf(key), 1, first, second);
    q.ongoingSplits.delete(key);
    original.unsubscribe();
  }

  private addPage(token: PaginatedQueryToken, cursor: string | null, numItems: number) {
    const q = this.mustGet(token);
    const key = q.nextPageKey++;
    const subscription = this.client.subscribe(q.udfPath, {
      ...q.args,
      paginationOpts: { cursor, numItems, id: q.id },
    });
    q.pageKeys.push(key);
    q.pages.set(key, { ...subscription, cursor });
  }

  private removeSubscriber(token: PaginatedQueryToken) {
    const q = this.queries.get(token);
    if (q === undefined) return;
    if (--q.subscribers > 0) return;
    for (const page of q.pages.values()) page.unsubscribe();
    this.queries.delete(token);
  }

  private page(q: PaginatedQuery, key: PageKey): Page {
    const page = q.pages.get(key);
    if (page === undefined) throw new Error(`No page query for pageKey ${key}`);
    return page;
  }

  private mustGet(token: PaginatedQueryToken): PaginatedQuery {
    const q = this.queries.get(token);
    if (q === undefined) throw new Error(`paginated query no longer exists for token ${token}`);
    return q;
  }
}
