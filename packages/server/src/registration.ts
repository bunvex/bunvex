// The function types (STUDY-36), as Convex's npm-packages/convex/src/server/registration.ts: contexts generic
// over the data model, registered functions that carry their kind, visibility, arguments and result (what
// `ApiFromModules` reads), and the builders `_generated/server` binds to an app's data model. Types only:
// the runtime is functions.ts, which hands every handler the same objects whatever the types say.
import type { GenericDatabaseReader, GenericDatabaseWriter, GenericDataModel } from "@bunvex/core";
import type {
  DefaultFunctionArgs,
  EmptyObject,
  FunctionReference,
  FunctionReturnType,
  FunctionVisibility,
  OptionalRestArgs,
} from "@bunvex/protocol";
import type { GenericValidator, Infer, ObjectType, PropertyValidators, Validator } from "@bunvex/values";
import type { Auth, FunctionDef, StorageActionWriter, StorageReader, StorageWriter } from "./functions.ts";
import type { PublicHttpAction } from "./router.ts";
import type { Scheduler } from "./scheduler.ts";

/** A query's context: a reader of the data model. */
export interface GenericQueryCtx<DataModel extends GenericDataModel> {
  db: GenericDatabaseReader<DataModel>;
  auth: Auth;
  storage: StorageReader;
}

/** A mutation's context: a writer of the data model, and the scheduler. */
export interface GenericMutationCtx<DataModel extends GenericDataModel> {
  db: GenericDatabaseWriter<DataModel>;
  auth: Auth;
  storage: StorageWriter;
  scheduler: Scheduler;
}

type Callable<Kind extends "query" | "mutation" | "action"> = FunctionReference<Kind, "public" | "internal">;

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
}

/** A function's arguments: one object, or none. */
type OneArgArray<ArgsObject extends DefaultFunctionArgs = DefaultFunctionArgs> = [ArgsObject];
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
