// Function paths and query tokens, as Convex's `sync/udf_path_utils.ts`.
import { toJsonValue, type Value } from "@bunvex/values";

/** `module:function`, with `.js` stripped from the module and `default` when no function is named. */
export function canonicalizeUdfPath(udfPath: string): string {
  const pieces = udfPath.split(":");
  const [moduleName, functionName] =
    pieces.length === 1 ? [pieces[0], "default"] : [pieces.slice(0, -1).join(":"), pieces[pieces.length - 1]];
  return `${moduleName.endsWith(".js") ? moduleName.slice(0, -3) : moduleName}:${functionName}`;
}

/** A query's name and arguments as one string: equal tokens are one subscription. Never leaves the client. */
export type QueryToken = string & { __queryToken: true };

export function serializePathAndArgs(udfPath: string, args: Record<string, Value>): QueryToken {
  return JSON.stringify({ udfPath: canonicalizeUdfPath(udfPath), args: toJsonValue(args) }) as QueryToken;
}
