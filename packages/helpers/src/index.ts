// Package @bunvex/helpers — the port of convex-helpers (STUDY-181): its root module, the small utilities and type
// helpers of convex-helpers' `index.ts` (get-convex/convex-helpers @ e48f9df, 0.1.128), with the same names,
// signatures, behaviour and messages. Written for bunvex; an app moves by importing `@bunvex/helpers`.
// biome-ignore-all lint/suspicious/noExplicitAny: the public signatures are convex-helpers', `any` included

/**
 * Apply an async function to every item of a list, all at once, and wait for every result (in the list's order).
 * The list may be any iterable (an array, a `Set`, `Object.keys(…)`) or a promise of one. Every call starts before
 * any is awaited, so the transforms run concurrently, as convex-helpers' `asyncMap`.
 */
export async function asyncMap<FromType, ToType>(
  list: Iterable<FromType> | Promise<Iterable<FromType>>,
  asyncTransform: (item: FromType, index: number) => Promise<ToType>,
): Promise<ToType[]> {
  const items = await list;
  const pending: Promise<ToType>[] = [];
  let i = 0;
  for (const item of items) pending.push(asyncTransform(item, i++));
  return Promise.all(pending);
}

/** The list without its `null` elements. */
export function pruneNull<T>(list: (T | null)[]): T[] {
  return list.filter((item): item is T => item !== null);
}

/** What `nullThrows` throws for a `null`. */
export class NullDocumentError extends Error {}

/**
 * The value, typed as not null; throws a `NullDocumentError` (with `message`, or "Unexpected null document.") when it
 * is `null`. Only `null` throws: `undefined` and other falsy values pass through.
 */
export function nullThrows<T>(doc: T | null, message?: string): T {
  if (doc === null) throw new NullDocumentError(message ?? "Unexpected null document.");
  return doc;
}

/**
 * A new object with only the given keys of `obj` (those it has): `pick({ a: v.string(), b: v.number() }, ["a"])`
 * is `{ a: v.string() }`.
 */
export function pick<T extends Record<string, any>, Keys extends (keyof T)[]>(obj: T, keys: Keys) {
  const wanted = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => wanted.has(key))) as {
    [K in Keys[number]]: T[K];
  };
}

/**
 * A new object with every own enumerable key of `obj` but the given ones: `omit({ a: v.string(), b: v.number() },
 * ["a"])` is `{ b: v.number() }`.
 */
export function omit<T extends Record<string, any>, Keys extends (keyof T)[]>(obj: T, keys: Keys) {
  const unwanted = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !unwanted.has(key))) as Expand<
    BetterOmit<T, Keys[number]>
  >;
}

/**
 * The object without `_id` and `_creationTime`: a document ready to insert again as a copy
 * (`db.insert(table, withoutSystemFields(doc))`), or a table's field validators without the system ones.
 */
export function withoutSystemFields<T extends Record<string, any>>(obj: T) {
  return omit(obj, ["_id", "_creationTime"]);
}

declare const errorBrand: unique symbol;
/** A string type that reads as an error message where a type does not fit (convex-helpers' `ErrorMessage`). */
export type ErrorMessage<Reason extends string> = Reason & { __error: typeof errorBrand };

/** An object with no keys (as Convex's `EmptyObject`). */
export type EmptyObject = Record<string, never>;

/**
 * `Omit` that applies to each member of a union and keeps the type's index signature.
 */
export type BetterOmit<T, K extends keyof T> = {
  [Property in keyof T as Property extends K ? never : Property]: T[Property];
};

/**
 * The same object type, written out: TypeScript shows `A & B` as one object. The identity on object types.
 */
export type Expand<ObjectType extends Record<any, any>> =
  ObjectType extends Record<any, any> ? { [Key in keyof ObjectType]: ObjectType[Key] } : never;

/**
 * `true` when the two types are exactly the same, `false` otherwise (the comparison from
 * https://github.com/Microsoft/TypeScript/issues/27024#issuecomment-421529650).
 */
export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Throws an `Error` unless `value` is truthy, and narrows its type otherwise. The message may be a function, called
 * only when the assertion fails (to skip building an expensive message).
 */
export function assert(value: unknown, message?: string | (() => string)): asserts value {
  if (value) return;
  throw new Error(typeof message === "function" ? message() : message);
}
