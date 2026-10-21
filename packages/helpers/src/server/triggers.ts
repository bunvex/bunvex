// convex-helpers' `server/triggers.ts` (STUDY-181 §1.1; get-convex/convex-helpers @ e48f9df, 0.1.128): functions
// registered per table that run whenever a document of that table is inserted, updated or deleted through the
// database `wrapDB` / `writerWithTriggers` returns. Same names, types, behaviour and messages as convex-helpers',
// written for bunvex.
//
// What the wrapped database does:
// - Only `insert`, `patch`, `replace` and `delete` on a table with triggers take the trigger path; every other write,
//   and `get`, `query`, `normalizeId`, `system` and `vars`, go straight to the inner database. A write given only an
//   id finds its table by `normalizeId` over the tables with triggers.
// - A write on the trigger path reads the document before and after it, then queues the table's triggers, in the
//   order they were registered, with the change.
// - A write made by the app (not by a trigger) holds the outer lock while it writes and drains the queue first in,
//   first out: a write made by a trigger only queues, so triggers that write run breadth-first.
// - Every trigger of the drain runs; the first error is thrown once the queue is empty, the others are logged.
// - A trigger gets `ctx` with `db`, a wrapped database whose writes queue, and `innerDb`, the database without
//   triggers.
//
// The one difference (DV-545, STUDY-181 H-4): convex-helpers keeps its two locks and its queue in module variables.
// On Convex a request evaluates its modules afresh, so they belong to one request; bunvex evaluates an app's modules
// once per code version (DV-164, DV-492), where module variables would be shared by every mutation running at the
// same time: their writes to tables with triggers serialized against each other, and one that never settles blocking
// the rest. They are kept per transaction here instead, keyed on the database the triggers wrap (the transaction's
// `ctx.db`, which every nested wrapper of one `wrapDB` shares). Within one request, what a function sees is
// convex-helpers'.
//
// As in `customFunctions`, `ctx` is merged without reading its getters (`overlay`, STUDY-181 §3.2).
// biome-ignore-all lint/suspicious/noExplicitAny: the writes take convex-helpers' untyped overload arguments

import type {
  DocumentByName,
  GenericDatabaseWriter,
  GenericDataModel,
  GenericMutationCtx,
  NamedTableInfo,
  QueryInitializer,
  TableNamesInDataModel,
  WithOptionalSystemFields,
  WithoutSystemFields,
} from "@bunvex/server";
import type { GenericId } from "@bunvex/values";
import { overlay } from "./overlay.ts";

/**
 * A function run when a document of `TableName` changes, with the mutation's `ctx` (its `db` wrapped, plus `innerDb`)
 * and the change.
 */
export type Trigger<Ctx, DataModel extends GenericDataModel, TableName extends TableNamesInDataModel<DataModel>> = (
  ctx: Ctx & { innerDb: GenericDatabaseWriter<DataModel> },
  change: Change<DataModel, TableName>,
) => Promise<void>;

/** A change to one document: its id, the operation, and the document before (`oldDoc`) and after (`newDoc`). */
export type Change<DataModel extends GenericDataModel, TableName extends TableNamesInDataModel<DataModel>> = {
  id: GenericId<TableName>;
} & (
  | { operation: "insert"; oldDoc: null; newDoc: DocumentByName<DataModel, TableName> }
  | {
      operation: "update";
      oldDoc: DocumentByName<DataModel, TableName>;
      newDoc: DocumentByName<DataModel, TableName>;
    }
  | { operation: "delete"; oldDoc: DocumentByName<DataModel, TableName>; newDoc: null }
);

/**
 * The triggers of an app: `register(table, trigger)` adds one, and `wrapDB(ctx)` returns `ctx` with a `db` whose
 * writes run them.
 *
 * ```ts
 * import { mutation as rawMutation } from "./_generated/server";
 * import type { DataModel } from "./_generated/dataModel";
 * import { Triggers } from "@bunvex/helpers/server/triggers";
 * import { customCtx, customMutation } from "@bunvex/helpers/server/customFunctions";
 *
 * const triggers = new Triggers<DataModel>();
 * triggers.register("messages", async (ctx, change) => {
 *   console.log("messages changed", change.operation, change.id);
 * });
 *
 * // Define every mutation with this builder, so that their writes run the triggers.
 * export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
 * ```
 */
export class Triggers<
  DataModel extends GenericDataModel,
  Ctx extends { db: GenericDatabaseWriter<DataModel> } = GenericMutationCtx<DataModel>,
> {
  /** The triggers of each table, in the order they were registered. */
  registered: { [TableName in TableNamesInDataModel<DataModel>]?: Trigger<Ctx, DataModel, TableName>[] } = {};

  /** Run `trigger` on every change to `tableName` made through a wrapped database, after the ones registered before. */
  register<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
    trigger: Trigger<Ctx, DataModel, TableName>,
  ) {
    const list = this.registered[tableName] ?? [];
    this.registered[tableName] = list;
    list.push(trigger);
  }

  /**
   * `ctx` with its `db` wrapped by `writerWithTriggers`. An arrow function, so that it can be passed as it is:
   * `customCtx(triggers.wrapDB)`.
   */
  wrapDB = <C extends Ctx>(ctx: C): C => overlay(ctx, { db: writerWithTriggers(ctx, ctx.db, this) }) as C;
}

/** A mutual exclusion: `run(f)` runs `f` once every `f` given before has settled. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<R>(f: () => Promise<R>): Promise<R> {
    const result = this.#tail.then(f);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

/**
 * The locks and queue of one transaction's trigger writes (convex-helpers' module-level `innerWriteLock`,
 * `outerWriteLock` and `triggerQueue`):
 * - `inner` serializes the writes on the trigger path, so each change is computed without another write in between;
 * - `outer` is held by a write the app makes for as long as it writes and drains the queue, its triggers' writes
 *   included, so a write and the triggers it causes are not interleaved with another of the app's writes;
 * - `queue` holds the triggers to run, in the order of the writes that queued them.
 */
type TriggerState = { inner: Mutex; outer: Mutex; queue: (() => Promise<void>)[] };

/** Each transaction's state, keyed on the database its triggers wrap (DV-545). */
const states = new WeakMap<object, TriggerState>();

function stateOf(innerDb: object): TriggerState {
  let state = states.get(innerDb);
  if (!state) {
    state = { inner: new Mutex(), outer: new Mutex(), queue: [] };
    states.set(innerDb, state);
  }
  return state;
}

/** @deprecated use `writerWithTriggers` instead */
export class DatabaseWriterWithTriggers<
  DataModel extends GenericDataModel,
  Ctx extends { db: GenericDatabaseWriter<DataModel> } = GenericMutationCtx<DataModel>,
> implements GenericDatabaseWriter<DataModel>
{
  writer: GenericDatabaseWriter<DataModel>;
  system: GenericDatabaseWriter<DataModel>["system"];
  vars: GenericDatabaseWriter<DataModel>["vars"];

  constructor(
    ctx: Ctx,
    innerDb: GenericDatabaseWriter<DataModel>,
    triggers: Triggers<DataModel, Ctx>,
    isWithinTrigger = false,
  ) {
    this.system = innerDb.system;
    this.vars = innerDb.vars;
    this.writer = writerWithTriggers(ctx, innerDb, triggers, isWithinTrigger);
  }

  get<TableName extends TableNamesInDataModel<DataModel>>(
    id: GenericId<TableName>,
  ): Promise<DocumentByName<DataModel, TableName> | null>;
  get<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<TableName>,
  ): Promise<DocumentByName<DataModel, TableName> | null>;
  get(arg0: any, arg1?: any): Promise<any> {
    return (this.writer.get as any)(arg0, arg1);
  }

  query<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
  ): QueryInitializer<NamedTableInfo<DataModel, TableName>> {
    return this.writer.query(tableName);
  }

  normalizeId<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
    id: string,
  ): GenericId<TableName> | null {
    return this.writer.normalizeId(tableName, id);
  }

  insert<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    value: WithoutSystemFields<DocumentByName<DataModel, TableName>>,
  ): Promise<GenericId<TableName>> {
    return this.writer.insert(table, value);
  }

  patch<Id extends GenericId<TableNamesInDataModel<DataModel>>>(
    id: Id,
    value: PatchValue<DocumentByName<DataModel, TableOfId<Id, DataModel>>>,
  ): Promise<void>;
  patch<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<NonUnion<TableName>>,
    value: PatchValue<DocumentByName<DataModel, TableName>>,
  ): Promise<void>;
  patch(arg0: any, arg1: any, arg2?: any): Promise<void> {
    return (this.writer.patch as any)(arg0, arg1, arg2);
  }

  replace<Id extends GenericId<TableNamesInDataModel<DataModel>>>(
    id: Id,
    value: WithOptionalSystemFields<DocumentByName<DataModel, TableOfId<Id, DataModel>>>,
  ): Promise<void>;
  replace<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<NonUnion<TableName>>,
    value: WithOptionalSystemFields<DocumentByName<DataModel, TableName>>,
  ): Promise<void>;
  replace(arg0: any, arg1: any, arg2?: any): Promise<void> {
    return (this.writer.replace as any)(arg0, arg1, arg2);
  }

  delete(id: GenericId<TableNamesInDataModel<DataModel>>): Promise<void>;
  delete<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<NonUnion<TableName>>,
  ): Promise<void>;
  delete(arg0: any, arg1?: any): Promise<void> {
    return (this.writer.delete as any)(arg0, arg1);
  }
}

/**
 * `innerDb` with the triggers of `triggers` run on its writes. `ctx` is what the triggers get (with `db` and `innerDb`
 * replaced); `isWithinTrigger` is true for the database a trigger gets, whose writes queue their triggers for the
 * drain already running instead of draining.
 */
export function writerWithTriggers<
  DataModel extends GenericDataModel,
  Ctx extends { db: GenericDatabaseWriter<DataModel> } = GenericMutationCtx<DataModel>,
>(
  ctx: Ctx,
  innerDb: GenericDatabaseWriter<DataModel>,
  triggers: Triggers<DataModel, Ctx>,
  isWithinTrigger = false,
): GenericDatabaseWriter<DataModel> {
  const state = stateOf(innerDb);
  const inner = innerDb as any;
  const hasTriggers = (table: string) => Boolean((triggers.registered as Record<string, unknown>)[table]);

  // The table of an id given alone: the first table with triggers that `normalizeId` accepts it for, else null.
  const tableOf = (id: string): string | null => {
    for (const table of Object.keys(triggers.registered)) {
      if (inner.normalizeId(table, id) !== null) return table;
    }
    return null;
  };

  // Write, then queue the table's triggers with the change; the app's own writes then drain the queue.
  const onTriggerPath = async <R>(table: string, write: () => Promise<[R, Change<DataModel, any>]>): Promise<R> => {
    const writeAndQueue = () =>
      state.inner.run(async () => {
        const [result, change] = await write();
        const triggerCtx = overlay(ctx, { db: writerWithTriggers(ctx, innerDb, triggers, true), innerDb }) as any;
        for (const trigger of (triggers.registered as Record<string, Trigger<Ctx, DataModel, any>[]>)[table] ?? []) {
          state.queue.push(() => trigger(triggerCtx, change));
        }
        return result;
      });
    if (isWithinTrigger) return await writeAndQueue();
    return await state.outer.run(async () => {
      const result = await writeAndQueue();
      let first: { error: unknown } | null = null;
      for (let next = state.queue.shift(); next !== undefined; next = state.queue.shift()) {
        try {
          await next();
        } catch (error) {
          if (first) console.error(error);
          else first = { error };
        }
      }
      if (first) throw first.error;
      return result;
    });
  };

  const update = (method: "patch" | "replace") => async (arg0: any, arg1: any, arg2?: any) => {
    const [table, id, value] = arg2 !== undefined ? [arg0, arg1, arg2] : [tableOf(arg0), arg0, arg1];
    if (table === null) return await inner[method](id, value);
    if (!hasTriggers(table)) return await inner[method](table, id, value);
    return await onTriggerPath(table, async () => {
      const oldDoc = await inner.get(table, id);
      await inner[method](table, id, value);
      const newDoc = await inner.get(table, id);
      return [undefined, { operation: "update", id, oldDoc, newDoc }];
    });
  };

  const writer = {
    insert: async (table: string, value: any) => {
      if (!hasTriggers(table)) return await inner.insert(table, value);
      return await onTriggerPath(table, async () => {
        const id = await inner.insert(table, value);
        const newDoc = await inner.get(table, id);
        return [id, { operation: "insert", id, oldDoc: null, newDoc }];
      });
    },
    patch: update("patch"),
    replace: update("replace"),
    delete: async (arg0: any, arg1?: any) => {
      const [table, id] = arg1 !== undefined ? [arg0, arg1] : [tableOf(arg0), arg0];
      if (table === null) return await inner.delete(id);
      if (!hasTriggers(table)) return await inner.delete(table, id);
      return await onTriggerPath(table, async () => {
        const oldDoc = await inner.get(table, id);
        await inner.delete(table, id);
        return [undefined, { operation: "delete", id, oldDoc, newDoc: null }];
      });
    },
    system: inner.system,
    get: inner.get.bind(inner),
    query: inner.query.bind(inner),
    normalizeId: inner.normalizeId.bind(inner),
    vars: inner.vars,
  };
  return writer as GenericDatabaseWriter<DataModel>;
}

/** The table of an id type, as one of the data model's tables. */
type TableOfId<Id, DataModel extends GenericDataModel> =
  Id extends GenericId<infer TableName> ? TableName & TableNamesInDataModel<DataModel> : never;

/** Keeps TypeScript from inferring a union for `TableName` when the table and the id given disagree. */
type NonUnion<T> = T extends never ? never : T;

/** A patch: some of a document's fields, each of which may also be `undefined` (removing it). */
type PatchValue<T> = { [P in keyof T]?: undefined extends T[P] ? T[P] | undefined : T[P] };
