// The functions of convex-helpers' `customFunctions.test.ts` (e48f9df), defined with `@bunvex/helpers`' custom
// builders and pushed by `bunvexTest` (STUDY-181 PR 2), so the tests call them as an app does.
//
// Where it differs from upstream's:
// - `create` guards `ctx.db.insert` itself: upstream wraps the database with `rowLevelSecurity`'s
//   `wrapDatabaseWriter` and takes a `vSessionId` from `sessions`, modules not ported yet. The error message is the
//   one `wrapDatabaseWriter` throws.
// - The `onSuccess` functions are pushed functions too (upstream calls `_handler` in `t.run`); their callbacks leave
//   a trace the test can read: a query's throws an error carrying what it was given, a mutation's and an action's
//   insert a `calls` row.
import {
  type CustomCtx,
  customAction,
  customCtx,
  customMutation,
  customQuery,
  NoOp,
} from "@bunvex/helpers/server/customFunctions";
import {
  type ActionBuilder,
  type Auth,
  actionGeneric,
  type DataModelFromSchemaDefinition,
  type GenericDatabaseReader,
  internalMutationGeneric,
  type MutationBuilder,
  makeFunctionReference,
  mutationGeneric,
  type QueryBuilder,
  queryGeneric,
} from "@bunvex/server";
import { type Value, v } from "@bunvex/values";
import type schema from "./schema.ts";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type DatabaseReader = GenericDatabaseReader<DataModel>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const action = actionGeneric as ActionBuilder<DataModel, "public">;

async function getUserByTokenIdentifier(ctx: { auth: Auth; db: DatabaseReader }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

// ---------------------------------------------------------------- user auth

const authenticatedQueryBuilder = customQuery(
  query,
  customCtx(async (ctx) => ({ user: await getUserByTokenIdentifier(ctx) })),
);
type AuthQueryCtx = CustomCtx<typeof authenticatedQueryBuilder>;

/** A bare handler: no `args`. */
export const unvalidatedArgsQuery = authenticatedQueryBuilder((ctx) => ({ user: ctx.user }));

function getSomethingInternal(ctx: AuthQueryCtx, args: { foo: string }) {
  return [args.foo, ctx.user._id];
}
export const getSomething = authenticatedQueryBuilder({ args: { foo: v.string() }, handler: getSomethingInternal });

const sessionMutationBuilder = customMutation(mutation, {
  args: { sessionId: v.string() },
  input: async (ctx, { sessionId }) => {
    const db = {
      insert: async (table: "users", doc: { tokenIdentifier: string }) => {
        if (doc.tokenIdentifier !== (await ctx.auth.getUserIdentity())?.tokenIdentifier)
          throw new Error("insert access not allowed");
        return ctx.db.insert(table, doc);
      },
    };
    return { ctx: { sessionId, db }, args: {} };
  },
});
export const create = sessionMutationBuilder({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, args) => {
    if (!ctx.sessionId) throw new Error("No session ID");
    return ctx.db.insert("users", args);
  },
});

// ---------------------------------------------------------------- api-key auth

const apiMutationBuilder = customMutation(mutation, {
  args: { apiKey: v.string() },
  input: async (_ctx, args) => {
    if (args.apiKey !== process.env.API_KEY) throw new Error("Invalid API key");
    return { ctx: {}, args: {} };
  },
});
export const fnCalledFromMyBackend = apiMutationBuilder({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, args) => ctx.db.insert("users", args),
});

// ---------------------------------------------------------------- noop

export const noopQuery = customQuery(
  query,
  NoOp,
)({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
export const noopMutation = customMutation(
  mutation,
  NoOp,
)({
  args: { foo: v.string() },
  handler: async (ctx, args) => ({
    bar: args.foo,
    // The merged ctx keeps a mutation's `rooms` a getter: built on first use, not by the merge.
    roomsIsGetter: typeof Object.getOwnPropertyDescriptor(ctx, "rooms")?.get === "function",
    canBroadcast: typeof ctx.rooms.broadcast === "function",
  }),
});
export const noopAction = customAction(
  action,
  NoOp,
)({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });

// ---------------------------------------------------------------- adding ctx

const addCtxArg = customQuery(
  query,
  customCtx(() => ({ a: "hi" })),
);
export const addC = addCtxArg({ args: {}, handler: async (ctx) => ({ ctxA: ctx.a }) });
export const addCU = addCtxArg({ handler: async (ctx) => ({ ctxA: ctx.a }) });
export const addCU2 = addCtxArg(async (ctx) => ({ ctxA: ctx.a }));
export const addCU3 = addCtxArg({ handler: async (ctx, _args: { foo: number }) => ({ ctxA: ctx.a }) });
export const addCtxWithExistingArg = addCtxArg({
  args: { b: v.string() },
  handler: async (ctx, args) => ({ ctxA: ctx.a, argB: args.b }),
});

// ---------------------------------------------------------------- adding args

const addArg = customQuery(query, { args: {}, input: async () => ({ ctx: {}, args: { a: "hi" } }) });
export const add = addArg({ args: {}, handler: async (_ctx, args) => ({ argsA: args.a }) });
export const addUnverified = addArg({ handler: async (_ctx, args) => ({ argsA: args.a }) });
export const addUnverified2 = addArg((_ctx, args) => ({ argsA: args.a }));

// ---------------------------------------------------------------- consuming an arg into ctx

export const consumeArg = customQuery(query, {
  args: { a: v.string() },
  input: async (_ctx, { a }) => ({ ctx: { a }, args: {} }),
});
export const consume = consumeArg({
  args: {},
  // The consumed arg is not the handler's: `args` is empty.
  handler: async (ctx, emptyArgs) => ({ ctxA: ctx.a, argKeys: Object.keys(emptyArgs) }),
});

// ---------------------------------------------------------------- passing an arg through, modifying, redefining

const passThroughArg = customQuery(query, {
  args: { a: v.string() },
  input: async (_ctx, args) => ({ ctx: { a: args.a }, args }),
});
export const passThrough = passThroughArg({ args: {}, handler: async (ctx, args) => ({ ctxA: ctx.a, argsA: args.a }) });

const modifyArg = customQuery(query, {
  args: { a: v.string() },
  input: async (_ctx, { a }) => ({ ctx: { a }, args: { a: 123 } }),
});
export const modify = modifyArg({
  args: {},
  handler: async (ctx, args) => {
    args.a.toFixed();
    return { ctxA: ctx.a, argsA: args.a };
  },
});

const redefineArg = customQuery(query, { args: { a: v.string() }, input: async (_ctx, args) => ({ ctx: {}, args }) });
export const redefine = redefineArg({ args: { a: v.string() }, handler: async (_ctx, args) => ({ argsA: args.a }) });

const refineArg = customQuery(query, {
  args: { a: v.optional(v.string()) },
  input: async (_ctx, args) => ({ ctx: {}, args }),
});
export const refined = refineArg({ args: { a: v.string() }, handler: async (_ctx, args) => ({ argsA: args.a }) });

// ---------------------------------------------------------------- nested custom functions

const inner = customQuery(
  query,
  customCtx(() => ({ inner: "inner" })),
);
const outerAdder = customQuery(inner, {
  args: { outer: v.string() },
  input: async (_ctx, args) => ({ ctx: { outer: args.outer }, args }),
});
export const outerAdds = outerAdder({
  args: { a: v.string() },
  handler: async (ctx, args) => ({ ctxInner: (ctx as Record<string, unknown>).inner, ctxOuter: ctx.outer, ...args }),
});
const outerRemover = customQuery(inner, {
  args: { outer: v.string() },
  input: async (_ctx, _args) => ({ ctx: { inner: undefined }, args: {} }),
});
export const outerRemoved = outerRemover({
  args: { a: v.string() },
  handler: async (ctx, args) => ({ ctxInner: ctx.inner, ...args }),
});

// ---------------------------------------------------------------- extra args

const extraArgQueryBuilder = customQuery(query, {
  args: { a: v.string() },
  input: async (_ctx, args, { extraArg }: { extraArg: string }) => ({ ctx: { extraArg }, args }),
});
export const extraArgQuery = extraArgQueryBuilder({
  args: {},
  extraArg: "foo",
  handler: async (ctx, args) => ({ ctxA: ctx.extraArg, argKeys: Object.keys(args) }),
});

// ---------------------------------------------------------------- onSuccess

/** Where a mutation's and an action's `onSuccess` leave their trace. */
export const record = internalMutation({
  args: { kind: v.string(), result: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.insert("calls", args);
  },
});
const recordRef = makeFunctionReference<"mutation", { kind: string; result: Value }>("customFunctions:record");

export const calls = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("calls").collect()).map(({ kind, result }) => ({ kind, result })),
});

const queryWithOnSuccess = customQuery(query, {
  args: { tag: v.string() },
  input: async (_ctx, { tag }) => ({
    ctx: { foo: "bar" },
    args: {},
    // A query writes nothing: its callback shows what it was given by failing with it.
    onSuccess: ({ ctx, args, result }) => {
      throw new Error(`onSuccess: ${JSON.stringify({ tag, result, args, ctxHasFoo: "foo" in ctx })}`);
    },
  }),
});
export const querySucceeds = queryWithOnSuccess({
  args: { n: v.number() },
  handler: async (ctx, args) => ({ success: true, foo: ctx.foo, n: args.n }),
});
export const queryThrows = queryWithOnSuccess({
  args: {},
  handler: async () => {
    throw new Error("Test error");
  },
});

const mutationWithOnSuccess = customMutation(mutation, {
  args: {},
  input: async () => ({
    ctx: { foo: "bar" },
    args: {},
    onSuccess: async ({ ctx, result }) => {
      await ctx.db.insert("calls", { kind: "mutation", result: result as Value });
    },
  }),
});
export const mutationSucceeds = mutationWithOnSuccess({
  args: {},
  handler: async (ctx) => ({ updated: true, foo: ctx.foo }),
});
export const mutationThrows = mutationWithOnSuccess({
  args: {},
  handler: async () => {
    throw new Error("Test error");
  },
});

const actionWithOnSuccess = customAction(action, {
  args: {},
  input: async () => ({
    ctx: { foo: "bar" },
    args: {},
    onSuccess: async ({ ctx, result }) => {
      await ctx.runMutation(recordRef, { kind: "action", result: result as Value });
    },
  }),
});
export const actionSucceeds = actionWithOnSuccess({
  args: {},
  handler: async (ctx) => ({ executed: true, foo: ctx.foo }),
});
export const actionThrows = actionWithOnSuccess({
  args: {},
  handler: async () => {
    throw new Error("Test error");
  },
});
