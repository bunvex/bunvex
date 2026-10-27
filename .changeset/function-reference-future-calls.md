---
"@bunvex/protocol": patch
"@bunvex/server": patch
---

`ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`, the scheduler and crons accept a `FunctionReference_future`, as `convex` 1.48 does. `FunctionArgs`, `FunctionReturnType`, `OptionalRestArgs` and `ArgsAndOptions` read its `_fn`. `FunctionReference` carries Convex's `_fn` too, so a reference whose arguments do not take the caller's is not a `FunctionReference_future`. `FunctionReference_future` now lives in `@bunvex/protocol` and is re-exported from `bunvex/server`.
