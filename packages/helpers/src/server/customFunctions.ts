// convex-helpers' `server/customFunctions.ts` (STUDY-181 §1.1; get-convex/convex-helpers @ e48f9df, 0.1.128):
// builders that wrap `query`, `mutation` and `action` (or their internal forms, or another custom builder) so every
// function they define gets more `ctx`, more or fewer arguments, and an optional callback after it succeeds. Same
// names, types, behaviour and messages as convex-helpers', written for bunvex.
//
// What a function built here does, in order:
// - its `args` are the function's own with the customization's added (`addFieldsToValidator`), so the engine
//   validates all of them before anything runs;
// - `input(ctx, the customization's args, extra)` runs, `extra` being the definition's keys other than `args`,
//   `returns` and `handler`;
// - the handler gets `ctx` with what `input` returned laid over it, and its own args with `input`'s added;
// - `onSuccess({ ctx, args, result })`, when `input` returned one, runs once the handler returned, never after a
//   throw.
//
// One difference of means, not of result (STUDY-181 §3.2): convex-helpers spreads `ctx` (`{ ...ctx, ...added }`),
// which reads every getter of it. A bunvex mutation's `ctx.rooms` is a getter that builds its broadcaster on first
// use (AD-42), so the merged `ctx` keeps `ctx`'s getters as getters instead: what the handler reads is the same, and
// nothing is built for a function that does not use it.
// biome-ignore-all lint/suspicious/noExplicitAny: the public signatures are convex-helpers', `any` included

import type {
  ActionBuilder,
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  DefaultFunctionArgs,
  FunctionVisibility,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
} from "@bunvex/server";
import type { GenericValidator, ObjectType, PropertyValidators, Validator } from "@bunvex/values";
import { type Expand, omit, pick } from "../index.ts";
import { addFieldsToValidator } from "../validators.ts";
import { overlay } from "./overlay.ts";

/** What `onSuccess` is called with: the function's original `ctx`, its args without the customization's, its result. */
type OnSuccess<Ctx> = (obj: { ctx: Ctx; args: Record<string, unknown>; result: unknown }) => void | Promise<void>;

/** What a customization's `input` returns: the `ctx` to lay over the function's, args to add, and `onSuccess`. */
type InputResult<CustomCtx, CustomMadeArgs, Ctx> = {
  ctx: CustomCtx;
  args: CustomMadeArgs;
  onSuccess?: OnSuccess<Ctx>;
};

/**
 * How a custom builder changes the functions it defines: the arguments it takes on top of each function's (`args`),
 * and `input`, which turns them (with the function's `ctx` and the definition's extra keys) into the `ctx` fields and
 * arguments the handler gets, and optionally an `onSuccess` callback run after the handler returned.
 *
 * ```ts
 * const withSession: Customization<QueryCtx, { sessionId: VId<"sessions"> }, { session: Doc<"sessions"> }, {}> = {
 *   args: { sessionId: v.id("sessions") },
 *   input: async (ctx, { sessionId }) => ({ ctx: { session: nullThrows(await ctx.db.get(sessionId)) }, args: {} }),
 * };
 * const sessionQuery = customQuery(query, withSession);
 * ```
 *
 * The customization's arguments reach the handler only when `input` returns them in `args`. A `ctx` field returned
 * as `undefined` hides the original one.
 */
export type Customization<
  // The `ctx` of the function being customized.
  Ctx extends Record<string, any>,
  // The validators of the arguments the customization takes.
  CustomArgsValidator extends PropertyValidators,
  // The fields laid over `ctx`.
  CustomCtx extends Record<string, any>,
  // The arguments added to the handler's.
  CustomMadeArgs extends Record<string, any>,
  // The definition's keys other than `args`, `returns` and `handler`, given to `input`.
  ExtraArgs extends Record<string, any> = Record<string, any>,
> = {
  args: CustomArgsValidator;
  input: (
    ctx: Ctx,
    args: ObjectType<CustomArgsValidator>,
    extra: ExtraArgs,
  ) => Promise<InputResult<CustomCtx, CustomMadeArgs, Ctx>> | InputResult<CustomCtx, CustomMadeArgs, Ctx>;
};

/**
 * A `Customization` with its types inferred from the object: it returns the object as it is.
 *
 * ```ts
 * const withSession = customCtxAndArgs({
 *   args: { sessionId: v.id("sessions") },
 *   input: async (ctx, { sessionId }) => ({ ctx: { session: await ctx.db.get(sessionId) }, args: {} }),
 * });
 * ```
 */
export function customCtxAndArgs<
  Ctx extends Record<string, any>,
  CustomArgsValidator extends PropertyValidators = PropertyValidators,
  CustomCtx extends Record<string, any> = Record<string, any>,
  CustomMadeArgs extends Record<string, any> = Record<string, any>,
  ExtraArgs extends Record<string, any> = Record<string, any>,
>(objectWithArgsAndInput: {
  args: CustomArgsValidator;
  input: (
    ctx: Ctx,
    args: ObjectType<CustomArgsValidator>,
    extra: ExtraArgs,
  ) => Promise<{ ctx: CustomCtx; args: CustomMadeArgs }> | { ctx: CustomCtx; args: CustomMadeArgs };
}): Customization<Ctx, CustomArgsValidator, CustomCtx, CustomMadeArgs, ExtraArgs> {
  return objectWithArgsAndInput;
}

/**
 * A `Customization` that only adds to `ctx`: `modifyCtx(ctx, extra)` returns the fields to lay over it. It takes no
 * arguments and adds none.
 */
export function customCtx<
  InCtx extends Record<string, any>,
  OutCtx extends Record<string, any>,
  ExtraArgs extends Record<string, any> = Record<string, any>,
>(
  modifyCtx: (original: InCtx, extra: ExtraArgs) => Promise<OutCtx> | OutCtx,
): Customization<InCtx, Record<string, never>, OutCtx, Record<string, never>, ExtraArgs> {
  return {
    args: {},
    input: async (ctx, _args, extra) => ({ ctx: await modifyCtx(ctx, extra), args: {} }),
  };
}

/** The `Customization` that changes nothing: no arguments, nothing added to `ctx` or args. */
export const NoOp = {
  args: {},
  input() {
    return { args: {}, ctx: {} };
  },
};

/**
 * A builder like `query` (or `internalQuery`, or another custom query builder) whose functions are changed by
 * `customization`: its arguments added to theirs, its `input` run before their handler.
 *
 * ```ts
 * const userQuery = customQuery(
 *   query,
 *   customCtx(async (ctx) => ({ user: await currentUser(ctx) })), // throws when nobody is signed in
 * );
 * export const myName = userQuery({ args: {}, handler: async (ctx) => ctx.user.name });
 * ```
 *
 * @param query The builder to customize, usually `query` or `internalQuery` from `_generated/server`.
 * @param customization The arguments it takes and how it changes `ctx` and args.
 * @returns A builder of queries with the changed `ctx` and args.
 */
export function customQuery<
  CustomArgsValidator extends PropertyValidators,
  CustomCtx extends Record<string, any>,
  CustomMadeArgs extends Record<string, any>,
  Visibility extends FunctionVisibility,
  DataModel extends GenericDataModel,
  ExtraArgs extends Record<string, any> = object,
>(
  query: QueryBuilder<DataModel, Visibility>,
  customization: Customization<GenericQueryCtx<DataModel>, CustomArgsValidator, CustomCtx, CustomMadeArgs, ExtraArgs>,
) {
  return customFnBuilder(query, customization) as CustomBuilder<
    "query",
    CustomArgsValidator,
    CustomCtx,
    CustomMadeArgs,
    GenericQueryCtx<DataModel>,
    Visibility,
    ExtraArgs
  >;
}

/**
 * A builder like `mutation` (or `internalMutation`, or another custom mutation builder) whose functions are changed
 * by `customization`, as `customQuery` does for queries.
 *
 * ```ts
 * const apiMutation = customMutation(mutation, {
 *   args: { apiKey: v.string() },
 *   input: async (_ctx, { apiKey }) => {
 *     if (apiKey !== process.env.API_KEY) throw new Error("Invalid API key");
 *     return { ctx: {}, args: {} };
 *   },
 * });
 * ```
 *
 * @param mutation The builder to customize, usually `mutation` or `internalMutation` from `_generated/server`.
 * @param customization The arguments it takes and how it changes `ctx` and args.
 * @returns A builder of mutations with the changed `ctx` and args.
 */
export function customMutation<
  CustomArgsValidator extends PropertyValidators,
  CustomCtx extends Record<string, any>,
  CustomMadeArgs extends Record<string, any>,
  Visibility extends FunctionVisibility,
  DataModel extends GenericDataModel,
  ExtraArgs extends Record<string, any> = object,
>(
  mutation: MutationBuilder<DataModel, Visibility>,
  customization: Customization<
    GenericMutationCtx<DataModel>,
    CustomArgsValidator,
    CustomCtx,
    CustomMadeArgs,
    ExtraArgs
  >,
) {
  return customFnBuilder(mutation, customization) as CustomBuilder<
    "mutation",
    CustomArgsValidator,
    CustomCtx,
    CustomMadeArgs,
    GenericMutationCtx<DataModel>,
    Visibility,
    ExtraArgs
  >;
}

/**
 * A builder like `action` (or `internalAction`, or another custom action builder) whose functions are changed by
 * `customization`, as `customQuery` does for queries.
 *
 * ```ts
 * const timedAction = customAction(action, {
 *   args: {},
 *   input: async () => {
 *     const start = Date.now();
 *     return { ctx: {}, args: {}, onSuccess: () => console.log(`took ${Date.now() - start} ms`) };
 *   },
 * });
 * ```
 *
 * @param action The builder to customize, usually `action` or `internalAction` from `_generated/server`.
 * @param customization The arguments it takes and how it changes `ctx` and args.
 * @returns A builder of actions with the changed `ctx` and args.
 */
export function customAction<
  CustomArgsValidator extends PropertyValidators,
  CustomCtx extends Record<string, any>,
  CustomMadeArgs extends Record<string, any>,
  Visibility extends FunctionVisibility,
  DataModel extends GenericDataModel,
  ExtraArgs extends Record<string, any> = object,
>(
  action: ActionBuilder<DataModel, Visibility>,
  customization: Customization<GenericActionCtx<DataModel>, CustomArgsValidator, CustomCtx, CustomMadeArgs, ExtraArgs>,
): CustomBuilder<
  "action",
  CustomArgsValidator,
  CustomCtx,
  CustomMadeArgs,
  GenericActionCtx<DataModel>,
  Visibility,
  ExtraArgs
> {
  return customFnBuilder(action, customization) as CustomBuilder<
    "action",
    CustomArgsValidator,
    CustomCtx,
    CustomMadeArgs,
    GenericActionCtx<DataModel>,
    Visibility,
    ExtraArgs
  >;
}

/** The builder every `custom*` returns: it defines each function through `builder`, wrapped by `customization`. */
function customFnBuilder(builder: (definition: any) => any, customization: Customization<any, any, any, any, any>) {
  const input: Customization<any, any, any, any, any>["input"] = customization.input ?? NoOp.input;
  const inputArgs: PropertyValidators = customization.args ?? NoOp.args;
  const inputKeys = Object.keys(inputArgs);
  return function customBuilder(definition: any): any {
    // A bare handler is its own `handler`, with no `args` or `returns`.
    const { args, handler = definition, returns, ...extra } = definition;
    /** Runs `input`, then the handler on the merged `ctx` and args, then `onSuccess`. */
    const run = async (ctx: any, inputArgsValue: any, ownArgs: any) => {
      const added = await input(ctx, inputArgsValue, extra);
      const result = await handler(overlay(ctx, added.ctx), { ...ownArgs, ...added.args });
      if (added.onSuccess) await added.onSuccess({ ctx, args: ownArgs, result });
      return result;
    };
    if (args) {
      return builder({
        args: addFieldsToValidator(args, inputArgs),
        returns,
        handler: (ctx: any, allArgs: any) => run(ctx, pick(allArgs, inputKeys), omit(allArgs, inputKeys)),
      });
    }
    if (inputKeys.length > 0)
      throw new Error(
        "If you're using a custom function with arguments for the input customization, you must declare the arguments for the function too.",
      );
    // Without `args`, `input` sees all of the function's arguments.
    return builder({ returns: definition.returns, handler: (ctx: any, allArgs: any) => run(ctx, allArgs, allArgs) });
  };
}

/** The registered function a custom builder of each kind makes: `RegisteredQuery`, `RegisteredMutation` or `RegisteredAction`. */
export type Registration<
  FuncType extends "query" | "mutation" | "action",
  Visibility extends FunctionVisibility,
  Args extends DefaultFunctionArgs,
  Output,
> = {
  query: RegisteredQuery<Visibility, Args, Output>;
  mutation: RegisteredMutation<Visibility, Args, Output>;
  action: RegisteredAction<Visibility, Args, Output>;
}[FuncType];

/** The handler's arguments: its own, with what `input` adds (none added leaves them as they are). */
type ArgsForHandlerType<OneOrZeroArgs extends [] | [Record<string, any>], CustomMadeArgs extends Record<string, any>> =
  CustomMadeArgs extends Record<string, never>
    ? OneOrZeroArgs
    : OneOrZeroArgs extends [infer A]
      ? [Expand<A & CustomMadeArgs>]
      : [CustomMadeArgs];

/**
 * A custom builder: it takes `{ args?, returns?, handler, ...extra }` or a bare handler, as `query` does, and its
 * function's arguments are the definition's with the customization's added. A customization that takes arguments
 * needs the definition's `args` too.
 */
export type CustomBuilder<
  FuncType extends "query" | "mutation" | "action",
  CustomArgsValidator extends PropertyValidators,
  CustomCtx extends Record<string, any>,
  CustomMadeArgs extends Record<string, any>,
  InputCtx,
  Visibility extends FunctionVisibility,
  ExtraArgs extends Record<string, any>,
> = <
  // biome-ignore lint/suspicious/noConfusingVoidType: no `args` (convex-helpers' constraint)
  ArgsValidator extends PropertyValidators | void | Validator<any, any>,
  // biome-ignore lint/suspicious/noConfusingVoidType: no `returns` (convex-helpers' constraint)
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(
  func:
    | ({
        args?: ArgsValidator;
        returns?: ReturnsValidator;
        handler: (
          ctx: Overwrite<InputCtx, CustomCtx>,
          ...args: ArgsForHandlerType<OneOrZeroArgs, CustomMadeArgs>
        ) => ReturnValue;
      } & {
        [key in keyof ExtraArgs as key extends "args" | "returns" | "handler" ? never : key]: ExtraArgs[key];
      })
    | ((
        ctx: Overwrite<InputCtx, CustomCtx>,
        ...args: ArgsForHandlerType<OneOrZeroArgs, CustomMadeArgs>
      ) => ReturnValue),
) => Registration<
  FuncType,
  Visibility,
  ArgsArrayToObject<
    CustomArgsValidator extends Record<string, never>
      ? OneOrZeroArgs
      : OneOrZeroArgs extends [infer A]
        ? [Expand<A & ObjectType<CustomArgsValidator>>]
        : [ObjectType<CustomArgsValidator>]
  >,
  ReturnValue
>;

/** The `ctx` a custom builder's handlers get: `CustomCtx<typeof myQuery>` types a helper that takes it. */
export type CustomCtx<Builder> =
  Builder extends CustomBuilder<any, any, infer CustomCtx, any, infer InputCtx, any, any>
    ? Overwrite<InputCtx, CustomCtx>
    : never;

/** `T` with `U`'s fields in place of its own. */
type Overwrite<T, U> = keyof U extends never ? T : Omit<T, keyof U> & U;

/**
 * @deprecated Renamed `Customization`.
 * How a builder changes `ctx` and args: the arguments it takes, and `input`, which returns the `ctx` fields and
 * arguments the handler gets. A `ctx` field returned as `undefined` hides the original one.
 */
export type Mod<
  Ctx extends Record<string, any>,
  ModArgsValidator extends PropertyValidators,
  ModCtx extends Record<string, any>,
  ModMadeArgs extends Record<string, any>,
  ExtraArgs extends Record<string, any> = Record<string, any>,
> = {
  args: ModArgsValidator;
  input: (
    ctx: Ctx,
    args: ObjectType<ModArgsValidator>,
    extra: ExtraArgs,
  ) => Promise<{ ctx: ModCtx; args: ModMadeArgs }> | { ctx: ModCtx; args: ModMadeArgs };
};
