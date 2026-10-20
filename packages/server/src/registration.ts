// The function types (STUDY-36), as Convex's npm-packages/convex/src/server/registration.ts: contexts generic
// over the data model, registered functions that carry their kind, visibility, arguments and result (what
// `ApiFromModules` reads), and the builders `_generated/server` binds to an app's data model. Types only:
// the runtime is functions.ts, which hands every handler the same objects whatever the types say.
import type {
  DocumentByInfo,
  FieldTypeFromFieldPath,
  GenericDatabaseReader,
  GenericDatabaseReaderWithTable,
  GenericDatabaseWriter,
  GenericDatabaseWriterWithTable,
  GenericDataModel,
  GenericDocument,
  GenericTableInfo,
  GenericVectorIndexConfig,
  NamedTableInfo,
  NamedVectorIndex,
  TableNamesInDataModel,
  VectorIndexNames,
} from "@bunvex/core";
import type {
  AnyFunctionReference,
  DefaultFunctionArgs,
  EmptyObject,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  FunctionVisibility,
  OptionalRestArgs,
} from "@bunvex/protocol";
import type {
  GenericId,
  GenericValidator,
  Infer,
  ObjectType,
  PropertyValidators,
  Validator,
  Value,
} from "@bunvex/values";
import type { Auth, FunctionDef, StorageActionWriter, StorageReader, StorageWriter } from "./functions.ts";
import type { ActionMeta, MutationMeta, QueryMeta } from "./meta.ts";
import type { PresenceDef, RoomDef } from "./rooms/define.ts";
import type { PublicHttpAction } from "./router.ts";
import type { Scheduler } from "./scheduler.ts";

type Callable<Kind extends "query" | "mutation" | "action"> = FunctionReference<Kind, "public" | "internal">;

/** Convex's `TransactionLimits`: lower a nested call's limits (STUDY-41). */
export type TransactionLimits = {
  bytesRead?: number;
  bytesWritten?: number;
  databaseQueries?: number;
  documentsRead?: number;
  documentsWritten?: number;
  functionsScheduled?: number;
  scheduledFunctionArgsBytes?: number;
};
/** Convex's `AdvancedRunQueryOptions` (`useStaleSnapshot` only from a mutation). */
export type AdvancedRunQueryOptions = { transactionLimits?: TransactionLimits; useStaleSnapshot?: boolean };

/** Convex's `ArgsAndOptions`: the arguments (optional when there are none), then the options. */
export type ArgsAndOptions<
  F extends FunctionReference<"query" | "mutation" | "action", "public" | "internal">,
  Options,
> =
  FunctionArgs<F> extends EmptyObject
    ? [args?: EmptyObject, options?: Options]
    : [args: FunctionArgs<F>, options?: Options];

/** A query's context: a reader of the data model, and the queries it may run in its transaction. */
export interface GenericQueryCtx<DataModel extends GenericDataModel> {
  db: GenericDatabaseReader<DataModel>;
  auth: Auth;
  storage: StorageReader;
  /** The function's, transaction's and deployment's metadata (STUDY-44). */
  meta: QueryMeta;
  /** Run a query in this query's transaction: its reads join this query's (STUDY-41). */
  runQuery<Query extends Callable<"query">>(
    query: Query,
    ...args: ArgsAndOptions<Query, { transactionLimits?: TransactionLimits }>
  ): Promise<FunctionReturnType<Query>>;
  // biome-ignore lint/suspicious/noExplicitAny: a function named by a string has an unknown result
  runQuery(
    name: string,
    args?: Record<string, unknown>,
    options?: { transactionLimits?: TransactionLimits },
  ): Promise<any>;
}

/** `ctx.rooms` in a mutation (sent once it commits) and an action (sent at once): AD-42. */
export interface RoomsBroadcaster {
  /** Send `event` with `data` to a room's members, from nobody (`from` is null). */
  broadcast(
    room: AnyFunctionReference | string,
    // biome-ignore lint/suspicious/noExplicitAny: a room is named by a string, its args are checked at run time
    args: Record<string, any>,
    event: string,
    data: unknown,
  ): Promise<void>;
}
/** `ctx.rooms` in an action: it also reads who is in a room. */
export interface RoomsReader extends RoomsBroadcaster {
  // biome-ignore lint/suspicious/noExplicitAny: as above
  members(
    room: AnyFunctionReference | string,
    args: Record<string, any>,
  ): Promise<{ memberId: string; userId: string | null; presence: unknown }[]>;
}
/** `ctx.presence` in an action: the users present in a presence scope. */
export interface PresenceReader {
  // biome-ignore lint/suspicious/noExplicitAny: as above
  list(
    scope: AnyFunctionReference | string,
    args: Record<string, any>,
  ): Promise<{ userId: string; state: unknown; idle: boolean }[]>;
}

/** A mutation's context: a writer of the data model, the scheduler, and the functions it may run. */
export interface GenericMutationCtx<DataModel extends GenericDataModel> {
  db: GenericDatabaseWriter<DataModel>;
  auth: Auth;
  storage: StorageWriter;
  scheduler: Scheduler;
  rooms: RoomsBroadcaster;
  /** The function's, transaction's, deployment's and request's metadata (STUDY-44). */
  meta: MutationMeta;
  /** Run a query in this mutation's transaction, seeing its writes (or, `useStaleSnapshot`, its snapshot). */
  runQuery<Query extends Callable<"query">>(
    query: Query,
    ...args: ArgsAndOptions<Query, AdvancedRunQueryOptions>
  ): Promise<FunctionReturnType<Query>>;
  // biome-ignore lint/suspicious/noExplicitAny: a function named by a string has an unknown result
  runQuery(name: string, args?: Record<string, unknown>, options?: AdvancedRunQueryOptions): Promise<any>;
  /** Run a mutation in a sub-transaction of this one: its writes are rolled back if it throws. */
  runMutation<Mutation extends Callable<"mutation">>(
    mutation: Mutation,
    ...args: ArgsAndOptions<Mutation, { transactionLimits?: TransactionLimits }>
  ): Promise<FunctionReturnType<Mutation>>;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  runMutation(
    name: string,
    args?: Record<string, unknown>,
    options?: { transactionLimits?: TransactionLimits },
  ): Promise<any>;
}

/** Convex's `GenericQueryCtxWithTable`: a query's context with the table-scoped database (STUDY-66 §2). */
export type GenericQueryCtxWithTable<DataModel extends GenericDataModel> = Omit<GenericQueryCtx<DataModel>, "db"> & {
  db: GenericDatabaseReaderWithTable<DataModel>;
};

/** Convex's `GenericMutationCtxWithTable`: a mutation's context with the table-scoped database. */
export type GenericMutationCtxWithTable<DataModel extends GenericDataModel> = Omit<
  GenericMutationCtx<DataModel>,
  "db"
> & {
  db: GenericDatabaseWriterWithTable<DataModel>;
};

/**
 * An action's context: no `db`, but the functions it runs. A reference's arguments and result are typed;
 * a plain name (`"module:fn"`) is untyped.
 */
// biome-ignore lint/correctness/noUnusedVariables: Convex's ActionCtx is generic over the data model too
export interface GenericActionCtx<DataModel extends GenericDataModel> {
  runQuery<Query extends Callable<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>>;
  // biome-ignore lint/suspicious/noExplicitAny: a function named by a string has an unknown result
  runQuery(name: string, args?: Record<string, unknown>): Promise<any>;
  runMutation<Mutation extends Callable<"mutation">>(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ): Promise<FunctionReturnType<Mutation>>;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  runMutation(name: string, args?: Record<string, unknown>): Promise<any>;
  runAction<Action extends Callable<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<FunctionReturnType<Action>>;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  runAction(name: string, args?: Record<string, unknown>): Promise<any>;
  auth: Auth;
  storage: StorageActionWriter;
  scheduler: Scheduler;
  rooms: RoomsReader;
  presence: PresenceReader;
  /** The function's, deployment's and request's metadata (STUDY-44). */
  meta: ActionMeta;
  /**
   * Convex's vector search (STUDY-51): the documents of `tableName` whose `vectorField` is most similar to
   * `query.vector` (cosine), `{_id, _score}` best first; `limit` 10 by default, at most 256; `filter` an OR
   * of `q.eq` on the index's filter fields.
   */
  vectorSearch<
    TableName extends TableNamesInDataModel<DataModel>,
    IndexName extends VectorIndexNames<NamedTableInfo<DataModel, TableName>>,
  >(
    tableName: TableName,
    indexName: IndexName,
    query: VectorSearchQuery<NamedTableInfo<DataModel, TableName>, IndexName>,
  ): Promise<Array<{ _id: GenericId<TableName>; _score: number }>>;
}

/**
 * `ctx.vectorSearch` for one table and index (Convex's `VectorSearch`): the documents whose vector is most similar
 * to `query.vector`, best first.
 */
export type VectorSearch<
  DataModel extends GenericDataModel,
  TableName extends TableNamesInDataModel<DataModel>,
  IndexName extends VectorIndexNames<NamedTableInfo<DataModel, TableName>>,
> = (
  tableName: TableName,
  indexName: IndexName,
  query: VectorSearchQuery<NamedTableInfo<DataModel, TableName>, IndexName>,
) => Promise<Array<{ _id: GenericId<TableName>; _score: number }>>;

/**
 * What a vector filter's operators return (Convex's `FilterExpression`, which it exports as a type only): an
 * expression whose value is a `T`.
 */
export declare abstract class FilterExpression<T extends Value | undefined> {
  /** Types only: makes the class nominal. */
  private readonly _isFilterExpression: undefined;
  /** Types only: the expression's value. */
  private readonly _value: T;
}

/** A vector search's filter builder (Convex's `VectorFilterBuilder`): equalities on the index's filter fields, ORed. */
export interface VectorFilterBuilder<
  Document extends GenericDocument,
  VectorIndexConfig extends GenericVectorIndexConfig,
> {
  /** The documents whose `fieldName` (one of the index's `filterFields`) is `value`. */
  eq<FieldName extends VectorIndexConfig["filterFields"]>(
    fieldName: FieldName,
    value: FieldTypeFromFieldPath<Document, FieldName>,
  ): FilterExpression<boolean>;
  /** The documents any of `exprs` matches. */
  or(...exprs: Array<FilterExpression<boolean>>): FilterExpression<boolean>;
}

/** A vector search's query (Convex's `VectorSearchQuery`): the vector, how many results (10 by default), a filter. */
export interface VectorSearchQuery<TableInfo extends GenericTableInfo, IndexName extends VectorIndexNames<TableInfo>> {
  vector: number[];
  limit?: number;
  filter?: (
    q: VectorFilterBuilder<DocumentByInfo<TableInfo>, NamedVectorIndex<TableInfo, IndexName>>,
  ) => FilterExpression<boolean>;
}

/**
 * A function's arguments: one object, or none. Without an `args` validator the object is `any`, where Convex's is
 * `DefaultFunctionArgs` (`Record<string, unknown>`): typing it so broke handlers that destructure their arguments
 * without types (bench/functions.ts), so it stays `any` (STUDY-180).
 */
// biome-ignore lint/suspicious/noExplicitAny: see above
type OneArgArray<ArgsObject extends DefaultFunctionArgs = Record<string, any>> = [ArgsObject];
export type ArgsArray = OneArgArray | [];
export type ArgsArrayToObject<Args extends ArgsArray> =
  Args extends OneArgArray<infer ArgsObject> ? ArgsObject : EmptyObject;

/** Convex's `Validator<any, "required", any>`: an `args` or `returns` validator may not be optional. */
// biome-ignore lint/suspicious/noExplicitAny: any type, required
type RequiredValidator = Validator<any, "required">;
type NullToUndefinedOrNull<T> = T extends null ? T | undefined | void : T;
/** What a handler may return for a `returns` type: it, or a promise of it (`undefined` for `null`). */
export type ValidatorTypeToReturnType<T> = Promise<NullToUndefinedOrNull<T>> | NullToUndefinedOrNull<T>;

export type ReturnValueForOptionalValidator<ReturnsValidator extends GenericValidator | PropertyValidators | void> = [
  ReturnsValidator,
] extends [GenericValidator]
  ? ValidatorTypeToReturnType<Infer<ReturnsValidator>>
  : [ReturnsValidator] extends [PropertyValidators]
    ? ValidatorTypeToReturnType<ObjectType<ReturnsValidator>>
    : // biome-ignore lint/suspicious/noExplicitAny: no `returns`: any result
      any;
export type ArgsArrayForOptionalValidator<ArgsValidator extends GenericValidator | PropertyValidators | void> = [
  ArgsValidator,
] extends [GenericValidator]
  ? OneArgArray<Infer<ArgsValidator>>
  : [ArgsValidator] extends [PropertyValidators]
    ? OneArgArray<ObjectType<ArgsValidator>>
    : ArgsArray;
export type DefaultArgsForOptionalValidator<ArgsValidator extends GenericValidator | PropertyValidators | void> = [
  ArgsValidator,
] extends [GenericValidator]
  ? [Infer<ArgsValidator>]
  : [ArgsValidator] extends [PropertyValidators]
    ? [ObjectType<ArgsValidator>]
    : OneArgArray;

/** `isPublic` or `isInternal`, and the visibility as a phantom type. */
type VisibilityProperties<Visibility extends FunctionVisibility> = {
  /** Phantom: not present at run time. */
  _visibility: Visibility;
} & (Visibility extends "public" ? { isPublic: true } : { isInternal: true });

/** A registered function, its arguments and result as phantom types (not present at run time). */
type Registered<Kind extends FunctionDef["kind"], Visibility extends FunctionVisibility, Args, Returns> = Extract<
  FunctionDef,
  { kind: Kind }
> & {
  isBunvexFunction: true;
  /** @internal The `args` validator's JSON (`{"type":"any"}` without one), read by the push's analysis. */
  exportArgs(): string;
  /** @internal The `returns` validator's JSON (`null` without one), read by the push's analysis. */
  exportReturns(): string;
  /** Phantom: not present at run time. */
  _args: Args;
  /** Phantom: not present at run time. */
  _returnType: Returns;
} & VisibilityProperties<Visibility>;

export type RegisteredQuery<
  Visibility extends FunctionVisibility,
  Args extends DefaultFunctionArgs,
  Returns,
> = Registered<"query", Visibility, Args, Returns> & { isQuery: true };
export type RegisteredMutation<
  Visibility extends FunctionVisibility,
  Args extends DefaultFunctionArgs,
  Returns,
> = Registered<"mutation", Visibility, Args, Returns> & { isMutation: true };
export type RegisteredAction<
  Visibility extends FunctionVisibility,
  Args extends DefaultFunctionArgs,
  Returns,
> = Registered<"action", Visibility, Args, Returns> & { isAction: true };

/** A builder's definition: `{ args?, returns?, handler }`, or the bare handler. */
type Definition<Ctx, ArgsValidator, ReturnsValidator, OneOrZeroArgs extends ArgsArray, ReturnValue> =
  | { args?: ArgsValidator; returns?: ReturnsValidator; handler: (ctx: Ctx, ...args: OneOrZeroArgs) => ReturnValue }
  | ((ctx: Ctx, ...args: OneOrZeroArgs) => ReturnValue);

/** `query` / `internalQuery` for a data model (Convex's `QueryBuilder`). */
export type QueryBuilder<DataModel extends GenericDataModel, Visibility extends FunctionVisibility> = <
  ArgsValidator extends PropertyValidators | RequiredValidator | void,
  ReturnsValidator extends PropertyValidators | RequiredValidator | void,
  // biome-ignore lint/suspicious/noExplicitAny: inferred from the handler; any when it cannot be
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(
  query: Definition<GenericQueryCtx<DataModel>, ArgsValidator, ReturnsValidator, OneOrZeroArgs, ReturnValue>,
) => RegisteredQuery<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

/** `mutation` / `internalMutation` for a data model (Convex's `MutationBuilder`). */
export type MutationBuilder<DataModel extends GenericDataModel, Visibility extends FunctionVisibility> = <
  ArgsValidator extends PropertyValidators | RequiredValidator | void,
  ReturnsValidator extends PropertyValidators | RequiredValidator | void,
  // biome-ignore lint/suspicious/noExplicitAny: inferred from the handler; any when it cannot be
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(
  mutation: Definition<GenericMutationCtx<DataModel>, ArgsValidator, ReturnsValidator, OneOrZeroArgs, ReturnValue>,
) => RegisteredMutation<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

/** Convex's `QueryBuilderWithTable`: `query` for a data model, its handler typed with the table-scoped API. */
export type QueryBuilderWithTable<DataModel extends GenericDataModel, Visibility extends FunctionVisibility> = <
  ArgsValidator extends PropertyValidators | RequiredValidator | void,
  ReturnsValidator extends PropertyValidators | RequiredValidator | void,
  // biome-ignore lint/suspicious/noExplicitAny: inferred from the handler; any when it cannot be
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(
  query: Definition<GenericQueryCtxWithTable<DataModel>, ArgsValidator, ReturnsValidator, OneOrZeroArgs, ReturnValue>,
) => RegisteredQuery<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

/** Convex's `MutationBuilderWithTable`. */
export type MutationBuilderWithTable<DataModel extends GenericDataModel, Visibility extends FunctionVisibility> = <
  ArgsValidator extends PropertyValidators | RequiredValidator | void,
  ReturnsValidator extends PropertyValidators | RequiredValidator | void,
  // biome-ignore lint/suspicious/noExplicitAny: inferred from the handler; any when it cannot be
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(
  mutation: Definition<
    GenericMutationCtxWithTable<DataModel>,
    ArgsValidator,
    ReturnsValidator,
    OneOrZeroArgs,
    ReturnValue
  >,
) => RegisteredMutation<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

/** `action` / `internalAction` for a data model (Convex's `ActionBuilder`). */
export type ActionBuilder<DataModel extends GenericDataModel, Visibility extends FunctionVisibility> = <
  ArgsValidator extends PropertyValidators | RequiredValidator | void,
  ReturnsValidator extends PropertyValidators | RequiredValidator | void,
  // biome-ignore lint/suspicious/noExplicitAny: inferred from the handler; any when it cannot be
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(
  action: Definition<GenericActionCtx<DataModel>, ArgsValidator, ReturnsValidator, OneOrZeroArgs, ReturnValue>,
) => RegisteredAction<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

/** `httpAction` (Convex's `HttpActionBuilder`). */
export type HttpActionBuilder = (
  // biome-ignore lint/suspicious/noExplicitAny: an HTTP action's context is not bound to the data model
  func: (ctx: GenericActionCtx<any>, request: Request) => Promise<Response>,
) => PublicHttpAction;

// ---------------------------------------------------------------- rooms and presence (AD-42, STUDY-164 §3.3)

/** A room's value as a validator or an object of field validators describes it. */
type ValueOfFields<F> = F extends PropertyValidators
  ? ObjectType<F>
  : F extends GenericValidator
    ? Infer<F>
    : EmptyObject;

/** A room definition, its arguments, presence and events as phantom types (not present at run time). */
export type RegisteredRoom<Args, Presence, Events> = RoomDef & {
  isBunvexRoom: true;
  __args?: Args;
  __presence?: Presence;
  __events?: Events;
};
/** A presence scope definition, its arguments and state as phantom types (not present at run time). */
export type RegisteredPresence<Args, State> = PresenceDef & {
  isBunvexRoom: true;
  __args?: Args;
  __state?: State;
};

type Fields = PropertyValidators | GenericValidator;
type Gate<DataModel extends GenericDataModel, Args> = (
  ctx: GenericQueryCtx<DataModel>,
  args: Args,
) => boolean | Promise<boolean>;

/** `room` for a data model: a room's presence and events, and who may join and publish. */
export type RoomBuilder<DataModel extends GenericDataModel> = <
  ArgsFields extends Fields | undefined = undefined,
  PresenceFields extends Fields = Fields,
  Events extends Record<string, Fields> = EmptyObject,
>(spec: {
  args?: ArgsFields;
  canJoin?: Gate<DataModel, ValueOfFields<ArgsFields>>;
  canPublish?: Gate<DataModel, ValueOfFields<ArgsFields>>;
  presence: PresenceFields;
  events?: Events;
}) => RegisteredRoom<
  ValueOfFields<ArgsFields>,
  ValueOfFields<PresenceFields>,
  { [K in keyof Events]: ValueOfFields<Events[K]> }
>;

/** `presence` for a data model: a signed-in user's state, present while any of their connections is. */
export type PresenceBuilder<DataModel extends GenericDataModel> = <
  ArgsFields extends Fields | undefined = undefined,
  StateFields extends Fields = Fields,
>(spec: {
  args?: ArgsFields;
  canJoin?: Gate<DataModel, ValueOfFields<ArgsFields>>;
  state: StateFields;
}) => RegisteredPresence<ValueOfFields<ArgsFields>, ValueOfFields<StateFields>>;
