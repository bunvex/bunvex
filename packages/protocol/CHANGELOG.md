# @bunvex/protocol

## 0.1.0-alpha.2

### Patch Changes

- b735691: `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`, the scheduler and crons accept a `FunctionReference_future`, as `convex` 1.48 does. `FunctionArgs`, `FunctionReturnType`, `OptionalRestArgs` and `ArgsAndOptions` read its `_fn`. `FunctionReference` carries Convex's `_fn` too, so a reference whose arguments do not take the caller's is not a `FunctionReference_future`. `FunctionReference_future` now lives in `@bunvex/protocol` and is re-exported from `bunvex/server`.
- 3b82fa1: `bunvex/server` and `bunvex/values` export every name Convex 1.46.0's `convex/server` and `convex/values` export, with Convex's shapes (STUDY-180), but the rule-5 renames and the five deprecated ones (DV-543). `ctx.storage` is typed by `StorageReader`, `StorageWriter` and `StorageActionWriter`: a query's or a mutation's has no `store`, and ids are `Id<"_storage">`. `ctx.vectorSearch` is typed by the table's vector indexes and a filter by the index's filter fields. `SchemaDefinition` has `doc()` / `id()`; `FieldTypeFromFieldPath` goes over each member of a union; `SearchFilter` is a class the search filter builder's objects extend; `asObjectValidator`, `NumericValue` and `VOptional` are in `bunvex/values`, and `v.optional` returns a `VOptional`. `DefaultFunctionArgs` is `Record<string, unknown>`.

## 0.1.0-alpha.1

### Minor Changes

- da1ea24: Function errors and log lines as Convex returns them: `BunvexError` data as `errorData`, `[Request ID: …] Server Error` messages with redaction (`REDACT_LOGS_TO_CLIENT`), HTTP 200 for function errors and `{code, message}` for request errors, and `console.*` lines returned as `logLines`.
