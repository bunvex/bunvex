// A query's or mutation's result as it stood when its handler's promise settled (STUDY-188 §X19 a). Convex serializes
// it there (`invokeQuery` / `invokeMutation`, npm-packages/convex/src/server/impl/registration_impl.ts: the handler's
// promise awaited, then `JSON.stringify(convexToJson(result))`), and no syscall's answer can reach the function's code
// before that: they resolve only from the isolate's loop (`environment/udf/mod.rs`). So code the handler left running
// (a read not awaited, its `.then` pushing into the returned array) never changes what the function returns. bunvex's
// reads can answer within the microtasks the server's own wrappers take after the handler: the result is copied at
// the handler's settle instead, before them.
import { isBytes, isSimpleObject, MAX_VALUE_NESTING } from "@bunvex/values";

/**
 * `value` copied as far as it is plain data: arrays, plain objects (their own enumerable fields, `undefined` ones
 * kept) and bytes. Anything else is kept as it is, for the checks after to refuse it with their own messages, and so
 * is what lies past the nesting limit (a cycle included), which those checks refuse too.
 */
export function resultSnapshot(value: unknown, depth = 0): unknown {
  if (depth > MAX_VALUE_NESTING + 1) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) if (i in value) out[i] = resultSnapshot(value[i], depth + 1);
    return out;
  }
  if (isBytes(value)) return value.slice(0);
  if (!isSimpleObject(value)) return value;
  const out: Record<string, unknown> = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const k of Object.keys(value)) out[k] = resultSnapshot(value[k], depth + 1);
  return out;
}

/**
 * What a handler returned, snapshotted where Convex serializes it: `invokeFunction` awaits
 * `Promise.resolve(func(ctx, args))`, then `invokeQuery` / `invokeMutation` awaits that and serializes, so the result is
 * read two microtask turns after the handler's promise settles. The same turns here, from the promise itself (of any
 * realm: `await` would add two more for another realm's), or from `Promise.resolve` of anything else, as Convex's.
 */
export function snapshotOnSettle(returned: unknown): Promise<unknown> {
  const settled =
    Object.prototype.toString.call(returned) === "[object Promise]"
      ? (returned as Promise<unknown>)
      : Promise.resolve(returned);
  return settled.then(same).then((v) => resultSnapshot(v)) as Promise<unknown>;
}

const same = (v: unknown) => v;
