// A query and its arguments as one object, as Convex's `browser/query_options.ts` (STUDY-102): the shape
// `BunvexReactClient.prewarmQuery` takes, and `bunvexQueryOptions`, which only gives it its type.
import type { AnyFunctionReference, FunctionArgs } from "@bunvex/protocol";

/** A query function reference and its arguments, as Convex's `QueryOptions`. `args` is required. */
export type QueryOptions<Query extends AnyFunctionReference & { _type: "query" }> = {
  /** The query to run. */
  query: Query;
  /** Its arguments. */
  args: FunctionArgs<Query>;
};

/**
 * @internal Returns `options` itself, typed as `QueryOptions<Query>`, so the query's type is inferred where the
 * object is written (`client.prewarmQuery(bunvexQueryOptions({ query, args }))`). Convex's `convexQueryOptions`,
 * renamed for rule 5 (DV-348); `@internal` there too.
 */
export function bunvexQueryOptions<Query extends AnyFunctionReference & { _type: "query" }>(
  options: QueryOptions<Query>,
): QueryOptions<Query> {
  return options;
}
