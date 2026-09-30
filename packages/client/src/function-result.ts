// The result of running a function on the server (Convex's `sync/function_result.ts`).
import type { Value } from "@bunvex/values";

export type FunctionSuccess = { success: true; value: Value; logLines: string[] };
export type FunctionFailure = { success: false; errorMessage: string; errorData?: Value; logLines: string[] };
export type FunctionResult = FunctionSuccess | FunctionFailure;
