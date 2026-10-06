// Function handles (STUDY-50), as Convex's (crates/model/src/components/handles.rs,
// npm-packages/convex/src/server/components): a string `function://<id>#<module:function>` naming a function
// by the id of its `_function_handles` row, which a push keeps: a row per function, its `deletedTs` set when
// the function goes and cleared if it comes back (so a handle outlives a delete and re-create). Anywhere a
// function reference is taken — `ctx.runQuery`, `runMutation`, `runAction`, the scheduler — a handle works
// too; only the id counts when resolving it.
import { AsyncLocalStorage } from "node:async_hooks";
import { type Engine, FUNCTION_HANDLES_TABLE, type Tx } from "@bunvex/core";
import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";

export const FUNCTION_HANDLE_PREFIX = "function://";

/** A handle to a function of type `Type` (Convex's `FunctionHandle`): a string, opaque to apps. */
export type FunctionHandle<
  _Type extends "query" | "mutation" | "action" = "query" | "mutation" | "action",
  _Args = unknown,
  _Return = unknown,
> = string & { __functionHandle: true };

export const isFunctionHandle = (s: unknown): boolean => typeof s === "string" && s.startsWith(FUNCTION_HANDLE_PREFIX);

type Row = { _id: string; component: null; path: string; deletedTs?: bigint | null };

/** Convex's `function_handle_not_found()`. */
const notFound = () => new Error("Function handle not found");

/** A function name as Convex's canonical path: `dir/module.js:function` (`default` when unnamed). */
export function canonicalPath(name: string): string {
  const i = name.lastIndexOf(":");
  const [m, f] = i === -1 ? [name, "default"] : [name.slice(0, i), name.slice(i + 1)];
  return `${m.endsWith(".js") ? m : `${m}.js`}:${f}`;
}
/** Convex's stripped path, a handle's advisory fragment: no `.js`, no `:default`. */
const stripped = (path: string) => path.replace(/\.js(?=:|$)/, "").replace(/:default$/, "");

const byPath = (db: Tx, path: string) =>
  db.asSystem(() =>
    db
      .query(FUNCTION_HANDLES_TABLE)
      .withIndex("by_component_path", (q) => q.eq("component", null).eq("path", path))
      .unique(),
  ) as unknown as Promise<Row | null>;

/**
 * Convex's `apply_config_diff`: after a push, a row for every function (a new one, or a revived tombstone),
 * and a tombstone (`deletedTs`, the transaction's snapshot) for each row whose function is gone.
 */
export async function syncFunctionHandles(db: Tx, paths: Iterable<string>) {
  const existing = new Map(
    (
      (await db.asSystem(() =>
        db
          .query(FUNCTION_HANDLES_TABLE)
          .withIndex("by_component_path", (q) => q.eq("component", null))
          .collect(),
      )) as unknown as Row[]
    ).map((r) => [r.path, r]),
  );
  for (const path of paths) {
    const row = existing.get(path);
    existing.delete(path);
    if (!row) await db.asSystem(() => db.insert(FUNCTION_HANDLES_TABLE, { component: null, path, deletedTs: null }));
    else if (row.deletedTs !== null && row.deletedTs !== undefined)
      await db.asSystem(() => db.patch(FUNCTION_HANDLES_TABLE, row._id, { deletedTs: null }));
  }
  for (const row of existing.values())
    if (row.deletedTs === null || row.deletedTs === undefined)
      await db.asSystem(() => db.patch(FUNCTION_HANDLES_TABLE, row._id, { deletedTs: db.snapshot }));
}

/** The handle of the function at canonical `path` (Convex's `FunctionHandlesModel::get`). */
export async function handleOf(db: Tx, path: string): Promise<string> {
  const row = await byPath(db, path);
  if (!row || (row.deletedTs !== null && row.deletedTs !== undefined)) throw notFound();
  return `${FUNCTION_HANDLE_PREFIX}${row._id}#${stripped(path)}`;
}

/** The canonical path a handle names (Convex's `FunctionHandlesModel::lookup`); read in `db`. */
export async function resolveHandle(db: Tx, handle: string): Promise<string> {
  const id = handle.slice(FUNCTION_HANDLE_PREFIX.length).split("#")[0]!;
  const docId = db.asSystemSync(() => db.normalizeId(FUNCTION_HANDLES_TABLE, id));
  if (!docId) throw new Error(`Invalid function handle ${handle}`);
  const row = (await db.asSystem(() => db.get(FUNCTION_HANDLES_TABLE, docId))) as unknown as Row | null;
  if (!row || (row.deletedTs !== null && row.deletedTs !== undefined)) throw notFound();
  return row.path;
}

/** The running function, for `createFunctionHandle`: its transaction (null in an action) and the engine. */
type Scope = { db: Tx | null; engine: Engine };
const scope = new AsyncLocalStorage<Scope>();
/** Run a function's handler where `createFunctionHandle` can find it. */
export const inHandleScope = <T>(s: Scope, fn: () => T): T => scope.run(s, fn);

/**
 * A function's name, a handle resolved to the path it names: in `db` when given (a query's or
 * mutation's transaction), else in a transaction of its own.
 */
/**
 * Convex's `getFunctionAddress` (components/paths.ts): how a call's syscall names its function, `{name}` or
 * `{functionHandle}` for a handle. Its text is part of what serde reads first (STUDY-135).
 */
export function functionAddress(ref: unknown): Record<string, string> {
  let name: string;
  try {
    name = typeof ref === "string" ? ref : getFunctionName(ref as AnyFunctionReference);
  } catch {
    return {};
  }
  return isFunctionHandle(name) ? { functionHandle: name } : { name };
}

export async function functionNameOf(ref: unknown, db: Tx | null, engine: Engine): Promise<string> {
  const name = typeof ref === "string" ? ref : getFunctionName(ref as AnyFunctionReference);
  if (!isFunctionHandle(name)) return name;
  return db ? resolveHandle(db, name) : engine.query((d) => resolveHandle(d, name));
}

/**
 * Convex's `createFunctionHandle(functionReference)`: the handle of a function of this deployment, which
 * can be stored and passed around, and called later by `ctx.runQuery` & co. or the scheduler.
 */
export async function createFunctionHandle<Type extends "query" | "mutation" | "action", Args, Return>(
  functionReference: unknown,
): Promise<FunctionHandle<Type, Args, Return>> {
  const s = scope.getStore();
  if (!s) throw new Error("createFunctionHandle can only be called from a query, mutation or action");
  const name =
    typeof functionReference === "string"
      ? functionReference
      : getFunctionName(functionReference as AnyFunctionReference);
  if (isFunctionHandle(name)) return name as FunctionHandle<Type, Args, Return>;
  if (name.startsWith("_system/")) throw new Error("Cannot create function handle for system UDF");
  const path = canonicalPath(name);
  return (await (s.db ? handleOf(s.db, path) : s.engine.query((db) => handleOf(db, path)))) as FunctionHandle<
    Type,
    Args,
    Return
  >;
}
