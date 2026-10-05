---
"@bunvex/server": patch
---

Registered functions have Convex's `exportArgs()` / `exportReturns()` (own properties, internal): their validators' JSON, `{"type":"any"}` without `args` and `"null"` without `returns`. The push's analysis and `apiSpec` read them, with Convex's errors for a broken export, and `apiSpec` (so `bunvex function-spec`) reports `returns: null` for a function without a `returns` validator, as Convex. A function whose `args` is a validator other than an object or `v.any()` now fails the push, as on Convex, and an export's validator JSON is parsed fully as Convex's backend parses it (its checks and messages; the stored JSON is the one Convex serializes back).
