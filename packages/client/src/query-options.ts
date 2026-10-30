// A query and its arguments as one object, as Convex's `browser/query_options.ts` (STUDY-102): the shape
// `BunvexReactClient.prewarmQuery` takes, and `bunvexQueryOptions`, which only gives it its type.
import type { AnyReference, FunctionArgs } from "@bunvex/protocol";

// Convex's `QueryOptions`.
/** A query function reference and its arguments. `args` is required. */
export type QueryOptions<Query extends AnyReference & { _type: "query" }> = {
  /** The query to run. */
  query: Query;
  /** Its arguments. */
  args: FunctionArgs<Query>;
};

// Convex's `convexQueryOptions`, renamed for rule 5 (DV-348); `@internal` there too.
/**
 * @internal Returns `options` itself, typed as `QueryOptions<Query>`, so the query's type is inferred where the object
 * is written (`client.prewarmQuery(bunvexQueryOptions({ query, args }))`).
 */
export function bunvexQueryOptions<Query extends AnyReference & { _type: "query" }>(
  options: QueryOptions<Query>,
): QueryOptions<Query> {
  return options;
}
