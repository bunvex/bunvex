// System documents as the contract shows them. The client hands over decoded values (int64 as bigint, bytes
// as ArrayBuffer); the contract's values are the JSON encoding Convex's `convexToJson` writes (`{$integer}`,
// `{$bytes}`), and its times are wall-clock milliseconds where the system tables keep nanoseconds.
import type { Json, Value } from "@bunvex/dashboard/data-source";
import { type Value as JsValue, toJsonValue } from "@bunvex/values";

/**
 * A decoded value in the contract's encoding (int64 as its 8 little-endian bytes, bytes in base64): the values
 * package's `toJsonValue`, as the tables' documents (`tables.ts`).
 */
export const encodeValue = (v: unknown): Value => toJsonValue(v as JsValue) as unknown as Value;

/** `encodeValue`, typed as the JSON an audit event's metadata is. */
export const encodeJson = (v: unknown) => encodeValue(v) as { [key: string]: Json };

/** Nanoseconds since the epoch (a system table's int64) as milliseconds. */
export const msOfNs = (ns: unknown): number => (typeof ns === "bigint" ? Number(ns / 1_000_000n) : Number(ns) / 1e6);

/** A number a system table keeps as int64. */
export const numberOf = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

/**
 * Arguments kept as the bytes of their JSON array (`_scheduled_job_args.args`, a cron's `udfArgs`), as Convex's
 * dashboard reads them (`JSON.parse(new TextDecoder().decode(udfArgs))`): the first element, already in the
 * contract's encoding.
 */
export function argsOfBytes(bytes: unknown): Record<string, Value> {
  if (!(bytes instanceof ArrayBuffer)) return {};
  const list = JSON.parse(new TextDecoder().decode(bytes)) as Value[];
  const first = list[0];
  return first !== null && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, Value>) : {};
}

/**
 * A function's canonical path, as Convex's dashboard passes its function identifiers (`module.js:name`): what
 * `paginatedScheduledJobs` matches exactly. `messages:send` → `messages.js:send`; a bare module → `:default`.
 */
export function canonicalPath(path: string): string {
  const i = path.lastIndexOf(":");
  const [module, name] = i === -1 ? [path, "default"] : [path.slice(0, i), path.slice(i + 1)];
  return `${/\.js$/.test(module) ? module : `${module}.js`}:${name}`;
}
