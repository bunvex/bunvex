# @bunvex/helpers

The port of [convex-helpers](https://github.com/get-convex/convex-helpers) to bunvex (STUDY-181): the same
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

What is there (convex-helpers 0.1.128):

- `@bunvex/helpers`: `asyncMap`, `pruneNull`, `nullThrows` / `NullDocumentError`, `pick`, `omit`,
  `withoutSystemFields`, `assert`, and the types `ErrorMessage`, `EmptyObject`, `BetterOmit`, `Expand`, `Equals`;
- `@bunvex/helpers/validators`: `literals`, `nullable`, `partial`, `systemFields`, `withSystemFields`,
  `addFieldsToValidator`, `doc`, `typedV`, `brandedString`, `deprecated`, `pretend`, `pretendRequired`,
  `ValidationError`, `validate`, `parse`, `vRequired`;
- `@bunvex/helpers/server/compare`: `compareValues` (deprecated upstream; it is `@bunvex/values`'s).

Custom functions, streams and pagination, and triggers come next (STUDY-181 §3.4).

Where it differs from convex-helpers (rule 5, DV-544): a validator's `isConvexValidator` is bunvex's
`isValidator`, and `vRequired` refuses an unknown kind with "Unknown validator type: ".

`@bunvex/server` and `@bunvex/values` are peer dependencies. The package has its own version, outside the fixed
group of the other `@bunvex/*` packages.
