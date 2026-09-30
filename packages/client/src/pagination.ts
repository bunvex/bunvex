// The shapes of a paginated query, as Convex's `browser/sync/pagination.ts` and `server/pagination.ts`: the
// options a page query takes, the result it returns, and the status the client derives.
import type { Value } from "@bunvex/values";

export type PaginationOptions = {
  numItems: number;
  cursor: string | null;
  endCursor?: string | null;
  /** A client-side cache-buster: pages of one `usePaginatedQuery` share it. */
  id?: number;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
};

export type PaginationResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/** A page query's result, checked. */
export function asPaginationResult(value: Value): PaginationResult<Value> {
  const v = value as Partial<PaginationResult<Value>> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    !Array.isArray(v.page) ||
    typeof v.isDone !== "boolean" ||
    typeof v.continueCursor !== "string"
  )
    throw new Error(`Not a valid paginated query result: ${String(value)}`);
  return v as PaginationResult<Value>;
}
