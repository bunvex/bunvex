---
"@bunvex/core": patch
"@bunvex/server": patch
---

Error messages as Convex's (checked against Convex's binary):

- A cursor that does not open fails with the keybroker's message alone: "Failed to parse cursor",
  "Key is invalid for instance …", "Missing position field" (no `InvalidCursor: ` prefix). An empty cursor
  or end cursor is a cursor too, and fails to parse.
- `paginate`'s options are checked where Convex checks them: no options is a `TypeError`; only a negative
  number or a non-number is "must be a positive number"; `numItems: 0` is "Must request at least 1 document
  while paginating"; a fractional, `NaN` or infinite size, a misfit `maximumRowsRead` / `maximumBytesRead`
  (a fraction, a negative number, a string…) and a cursor that is not a string fail with serde's message
  ("Invalid arguments for `queryPage`: …"), in Convex's field order. A null limit is no limit (it read nothing
  before), and a fractional size is refused instead of rounded down.
- A float in a `limit` or `queryPage` argument error is worded as serde_json's (`1e-7`, `1e+21`).
- A system function's argument error is `Uncaught Error: <check>`, as Convex's system functions check their
  own arguments, instead of `ArgumentValidationError: <check>`.
