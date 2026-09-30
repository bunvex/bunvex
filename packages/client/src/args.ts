import { isSimpleObject, type Value } from "@bunvex/values";

/** A function's arguments: an object, `{}` when omitted (Convex's `parseArgs`). */
export function parseArgs(args: Record<string, Value> | undefined): Record<string, Value> {
  if (args === undefined) return {};
  if (!isSimpleObject(args))
    throw new Error(`The arguments to a bunvex function must be an object. Received: ${args as unknown}`);
  return args;
}
