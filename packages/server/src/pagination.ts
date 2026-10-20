// Pagination validators, as Convex's `convex/server` exports them (npm-packages/convex/src/server/pagination.ts).
import { type GenericValidator, v } from "@bunvex/values";

/** A position in a paginated query (Convex's `Cursor`): an opaque string. */
export type Cursor = string;

/**
 * `.paginate()`'s options (Convex's `PaginationOptions`): how many items, from which cursor, up to which one. The
 * validator below also takes the `id` Convex's client adds; the type leaves it out, as Convex's.
 */
export interface PaginationOptions {
  numItems: number;
  cursor: Cursor | null;
  endCursor?: Cursor | null;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
}

/** The shape of `.paginate()`'s options, for a function's `args`. */
export const paginationOptsValidator = v.object({
  numItems: v.number(),
  cursor: v.union(v.string(), v.null()),
  endCursor: v.optional(v.union(v.string(), v.null())),
  id: v.optional(v.number()),
  maximumRowsRead: v.optional(v.number()),
  maximumBytesRead: v.optional(v.number()),
});

/** A validator of `.paginate()`'s result, for a function's `returns`. */
export const paginationResultValidator = (itemValidator: GenericValidator) =>
  v.object({
    page: v.array(itemValidator),
    continueCursor: v.string(),
    isDone: v.boolean(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  });
