# @bunvex/helpers

The port of [convex-helpers](https://github.com/get-convex/convex-helpers) to bunvex: the same
exports, signatures, behaviour and messages, written for bunvex. An app moves by renaming `convex-helpers` to
`@bunvex/helpers` in its imports; the subpaths are the same.

```ts
import { asyncMap, nullThrows, pick } from "@bunvex/helpers";
import { literals, nullable, parse, partial, validate } from "@bunvex/helpers/validators";

const status = literals("active", "inactive");
const args = { name: v.string(), status, nickname: nullable(v.string()) };

const users = await asyncMap(ids, (id) => ctx.db.get("users", id));
const user = nullThrows(await ctx.db.get("users", id), "no such user");

validate(v.object(args), value, { throw: true, db: ctx.db }); // ids checked against their table
const clean = parse(v.object(args), body); // unknown fields stripped
```

```ts
import { customCtx, customMutation, customQuery } from "@bunvex/helpers/server/customFunctions";

// Every function of this builder gets `ctx.user`, or fails for a caller who is not signed in.
const userQuery = customQuery(query, customCtx(async (ctx) => ({ user: await currentUser(ctx) })));
export const myName = userQuery({ args: {}, handler: async (ctx) => ctx.user.name });

// An argument every function takes, consumed before the handler runs, and a callback after it succeeds.
const apiMutation = customMutation(mutation, {
  args: { apiKey: v.string() },
  input: async (_ctx, { apiKey }) => {
    if (apiKey !== process.env.API_KEY) throw new Error("Invalid API key");
    return { ctx: {}, args: {}, onSuccess: ({ result }) => console.log("done", result) };
  },
});
```

```ts
import { customCtx, customMutation } from "@bunvex/helpers/server/customFunctions";
import { Triggers } from "@bunvex/helpers/server/triggers";

// Keep `fullName` in step with `firstName` and `lastName`, whichever mutation writes a user.
const triggers = new Triggers<DataModel>();
triggers.register("users", async (ctx, change) => {
  if (!change.newDoc) return; // a delete
  const fullName = `${change.newDoc.firstName} ${change.newDoc.lastName}`;
  if (change.newDoc.fullName !== fullName) await ctx.db.patch("users", change.id, { fullName });
});
// Define every mutation with this builder, so that their writes run the triggers.
export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
```

What is there (convex-helpers 0.1.128):

- `@bunvex/helpers`: `asyncMap`, `pruneNull`, `nullThrows` / `NullDocumentError`, `pick`, `omit`,
  `withoutSystemFields`, `assert`, and the types `ErrorMessage`, `EmptyObject`, `BetterOmit`, `Expand`, `Equals`;
- `@bunvex/helpers/validators`: `literals`, `nullable`, `partial`, `systemFields`, `withSystemFields`,
  `addFieldsToValidator`, `doc`, `typedV`, `brandedString`, `deprecated`, `pretend`, `pretendRequired`,
  `ValidationError`, `validate`, `parse`, `vRequired`;
- `@bunvex/helpers/server/customFunctions`: `customQuery`, `customMutation`, `customAction`, `customCtx`,
  `customCtxAndArgs`, `NoOp`, and the types `Customization`, `CustomBuilder`, `CustomCtx`, `Registration` and `Mod`
  (deprecated upstream);
- `@bunvex/helpers/server/triggers`: `Triggers` (`register`, `wrapDB`), `writerWithTriggers`, the types `Trigger` and
  `Change`, and `DatabaseWriterWithTriggers` (deprecated upstream);
- `@bunvex/helpers/server/compare`: `compareValues` (deprecated upstream; it is `@bunvex/values`'s);
- `@bunvex/helpers/server/stream`: `stream`, `StreamDatabaseReader`, `QueryStream` (`filterWith`, `map`, `flatMap`,
  `distinct`, `paginate` with `endCursor`, `maximumRowsRead`, `maximumBytesRead`, `pageStatus` and `splitCursor`,
  `collect`, `take`, `first`, `unique`), `mergedStream`, `streamIndexRange`, `getIndexFields`, `SingletonStream`,
  `EmptyStream`, and the types;
- `@bunvex/helpers/server/pagination`: `getPage` (`PageRequest`, `PageResponse`), `streamQuery`, `paginator`, and
  `IndexKey`.

```ts
import { mergedStream, stream } from "@bunvex/helpers/server/stream";
import schema from "./schema";

// Messages of several authors, by creation time, a page at a time.
const byAuthor = (author: string) =>
  stream(ctx.db, schema).query("messages").withIndex("by_author", (q) => q.eq("author", author));
const page = await mergedStream(authors.map(byAuthor), ["_creationTime"])
  .filterWith(async (m) => !m.deleted)
  .paginate({ ...paginationOpts, maximumRowsRead: 1000 });
```

A stream's cursors are convex-helpers' own, byte for byte: the value JSON of an index key, `undefined`
as `"undefined"`, and `"[]"` at the end. A cursor stored by an app or a component on Convex keeps working.

```ts
import { getPage, paginator } from "@bunvex/helpers/server/pagination";

// Pages an app stitches together: each starts after the last one's last key, and ends at its own when re-read.
const { page, hasMore, indexKeys } = await getPage(ctx, {
  table: "messages",
  index: "by_author",
  schema,
  startIndexKey: previousPage?.indexKeys.at(-1),
  targetMaxRows: 50,
});

// A `ctx.db` whose `paginate` runs anywhere, in a component too; pass `endCursor` to keep a page's end on reruns.
const result = await paginator(ctx.db, schema)
  .query("messages")
  .withIndex("by_author", (q) => q.eq("author", author))
  .paginate({ cursor, numItems: 20 });
```

`getPage` returns each document's raw index key (`indexKeys`), not a cursor; it reads one row past its limit to set
`hasMore`. `PageRequest.indexFields` is accepted and not read, as upstream: a named index needs `schema`.

The other parts of convex-helpers come later.

Where it differs from convex-helpers: a validator's `isConvexValidator` is bunvex's
`isValidator`, and `vRequired` refuses an unknown kind with "Unknown validator type: ". `server/stream` uses
`@bunvex/values`' `toJsonValue` / `fromJsonValue` where upstream uses `convexToJson` / `jsonToConvex`: the same
encoding.

A custom function's handler sees the same `ctx` as upstream's, built differently: upstream spreads `ctx`, which reads
each of its getters, where this keeps them getters, so a mutation's `ctx.rooms` is still built only on first use.
Triggers merge `ctx` the same way.

Triggers keep their locks and queue per transaction, where convex-helpers keeps them in module variables. On
Convex a request evaluates its modules afresh, so the two are the same within a request; bunvex evaluates them once
per code version, where module variables would make mutations running at the same time wait on each other's writes to
tables with triggers.

`@bunvex/server` and `@bunvex/values` are peer dependencies. The package has its own version, outside the fixed
group of the other `@bunvex/*` packages.
