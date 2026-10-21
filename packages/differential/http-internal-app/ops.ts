// A query that fails with a system error on both backends: a page of `limit(0)` has no cursor at all, which Convex's
// `read_page_from_query` fails with "Cursor was None" (an internal error, not the app's), and bunvex with its
// `QueryCursorError`.
import { queryGeneric } from "convex/server";

export const emptyPage = queryGeneric({
  args: {},
  handler: async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: `limit` is the query's own operator, not in its public type
    await (ctx.db.query("items") as any).limit(0).paginate({ numItems: 5, cursor: null });
    return 1;
  },
});
