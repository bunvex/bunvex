// The client's context types and the name a job is logged under (STUDY-199 §1.16), as Convex's workpool's `utils.ts`.
import {
  type FunctionReference,
  type FunctionType,
  type FunctionVisibility,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  getFunctionAddress,
  getFunctionName,
} from "@bunvex/server";

/** What the client needs of a query's context. */
export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
/** What the client needs of a mutation's context. */
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
/** What the client needs of an action's context. */
export type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;

/** A function's name for the logs: its path, its component reference or its handle. */
export function safeFunctionName(f: FunctionReference<FunctionType, FunctionVisibility>): string {
  const address = getFunctionAddress(f) as { name?: string; reference?: string; functionHandle?: string };
  return address.name || address.reference || address.functionHandle || getFunctionName(f);
}
