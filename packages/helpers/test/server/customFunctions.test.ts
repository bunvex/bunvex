// convex-helpers' `server/customFunctions.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 2). Upstream defines the
// functions in the test module and runs them on convex-test; here they are a project (fixtures/custom-functions)
// pushed by `@bunvex/testing`'s `bunvexTest`, so each call goes through the engine as an app's does: the merged
// `args` validated, the handler run in its transaction. The type assertions (vitest's `expectTypeOf` /
// `assertType`) are `Equals` checks and assignments, which `tsc` runs.
//
// Where it differs from upstream:
// - Upstream's `onSuccess` tests call the registered function's `_handler` (Convex's private field) inside `t.run`;
//   here the functions are pushed and called by reference, and their callbacks leave a trace (see the fixture).
// - convex-test words an argument mismatch "Validator error: …"; bunvex's engine, as Convex's backend, says
//   "ArgumentValidationError: …".
// - The user-auth test's database guard and session id are the fixture's own (no `rowLevelSecurity` / `sessions`
//   modules yet), with the same messages.
// - Upstream's nested `outerRemoved` checks `toStrictEqual`; `bunvexTest` returns the handler's object without turning
//   it into a value, so its `undefined` field is there (see the test).
// - A function without `args` under a customization with args is not a type error here (see the test), only a
//   run-time one.
// biome-ignore-all lint/suspicious/noExplicitAny: the ported tests use `any` as convex-helpers' do
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type ActionBuilder,
  actionGeneric,
  anyApi,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
  mutationGeneric,
  type QueryBuilder,
  queryGeneric,
} from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { v } from "@bunvex/values";
import type { Equals } from "../../src/index.ts";
import {
  type Customization,
  customAction,
  customCtx,
  customCtxAndArgs,
  customMutation,
  customQuery,
  type Mod,
  NoOp,
} from "../../src/server/customFunctions.ts";
import type schema from "../fixtures/custom-functions/bunvex/schema.ts";

const APP = join(import.meta.dir, "..", "fixtures", "custom-functions");
const api = anyApi.customFunctions as any;

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const make = (env?: Record<string, string>) => {
  const t = bunvexTest({ cwd: APP, env });
  open.push(t);
  return t;
};

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const action = actionGeneric as ActionBuilder<DataModel, "public">;

// ---------------------------------------------------------------- types (checked by tsc)

// Without added args, a custom builder is the builder it wraps.
customQuery(
  query,
  customCtx((_ctx) => ({ foo: "bar" })),
) satisfies typeof query;
customMutation(
  mutation,
  customCtx((_ctx) => ({})),
) satisfies typeof mutation;
customAction(
  action,
  customCtx((_ctx) => ({})),
) satisfies typeof action;
customQuery({} as any, { args: {}, input: async () => ({ ctx: {}, args: {} }) }) satisfies typeof query;
customMutation(mutation, { args: {}, input: async () => ({ ctx: {}, args: {} }) }) satisfies typeof mutation;
customAction(action, { args: {}, input: async () => ({ ctx: {}, args: {} }) }) satisfies typeof action;

// NoOp leaves a function's type as the plain builder's.
{
  const viaNoOp = customQuery(
    query,
    NoOp,
  )({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
  const plain = query({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
  const same: Equals<typeof viaNoOp, typeof plain> = true;
  const viaNoOpM = customMutation(
    mutation,
    NoOp,
  )({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
  const plainM = mutation({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
  const sameM: Equals<typeof viaNoOpM, typeof plainM> = true;
  const viaNoOpA = customAction(
    action,
    NoOp,
  )({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
  const plainA = action({ args: { foo: v.string() }, handler: async (_ctx, args) => ({ bar: args.foo }) });
  const sameA: Equals<typeof viaNoOpA, typeof plainA> = true;
  void [same, sameM, sameA];
}

// A consumed arg is the function's (its `_args`), not the handler's.
{
  const consumeArg = customQuery(query, {
    args: { a: v.string() },
    input: async (_ctx, { a }) => ({ ctx: { a }, args: {} }),
  });
  const fn = consumeArg({
    args: {},
    handler: async (ctx, emptyArgs) => {
      const empty: Record<string, never> = emptyArgs;
      const a: string = ctx.a;
      return [empty, a];
    },
  });
  const argsType: Equals<(typeof fn)["_args"], { a: string }> = true;
  void argsType;
}

// `customCtxAndArgs` and the deprecated `Mod` type the same object as `Customization`.
{
  const c = customCtxAndArgs({ args: { n: v.number() }, input: (_ctx: object, { n }) => ({ ctx: { n }, args: {} }) });
  const asCustomization: Customization<object, { n: typeof c.args.n }, { n: number }, Record<string, never>> = c;
  const asMod: Mod<object, { n: typeof c.args.n }, { n: number }, Record<string, never>> = c;
  void [asCustomization, asMod];
}

// ---------------------------------------------------------------- definition-time errors

describe("defining", () => {
  test("a customization with args needs the function's args", () => {
    const consumeArg = customQuery(query, {
      args: { a: v.string() },
      input: async (_ctx, { a }) => ({ ctx: { a }, args: {} }),
    });
    expect(() =>
      consumeArg({
        // Upstream marks this `@ts-expect-error`: there, a handler without `args` takes `Record<string, unknown>`,
        // which `object` is not. bunvex types it `Record<string, any>` (registration.ts, STUDY-180), which `object`
        // is, so only the run-time error is left.
        handler: async (ctx, emptyArgs: object) => [ctx.a, emptyArgs],
      }),
    ).toThrow(
      "If you're using a custom function with arguments for the input customization, you must declare the arguments for the function too.",
    );
    // A bare handler too.
    expect(() => consumeArg((ctx: any) => ctx.a)).toThrow("you must declare the arguments for the function too.");
  });

  test("redefining an arg with another kind throws", () => {
    const badRedefineArg = customQuery(query, {
      args: { a: v.string(), b: v.number() },
      input: async (_ctx, args) => ({ ctx: {}, args }),
    });
    expect(() =>
      badRedefineArg({ args: { a: v.number() }, handler: async (_ctx, args) => ({ argsA: args.a }) }),
    ).toThrow("Cannot intersect validators with different kinds: float64 and string");
  });

  test("the function's args are its own with the customization's added", () => {
    const withSession = customQuery(query, {
      args: { sessionId: v.string() },
      input: async () => ({ ctx: {}, args: {} }),
    });
    const fn = withSession({ args: { n: v.number() }, returns: v.number(), handler: async (_ctx, { n }) => n });
    expect(JSON.parse(fn.exportArgs())).toEqual(
      JSON.parse(JSON.stringify(v.object({ n: v.number(), sessionId: v.string() }).json)),
    );
    expect(JSON.parse(fn.exportReturns())).toEqual(JSON.parse(JSON.stringify(v.number().json)));
    // Without `args`, the function is unvalidated as the plain builder's.
    const bare = customQuery(query, NoOp)(async () => 1);
    expect(JSON.parse(bare.exportArgs())).toEqual({ type: "any" });
  });
});

// ---------------------------------------------------------------- running

test("custom function with user auth", async () => {
  const t = make();
  const userId = await t.run(async (ctx: any) => ctx.db.insert("users", { tokenIdentifier: "foo" }));
  const authed = t.withIdentity({ tokenIdentifier: "foo" });

  // The custom function is protected by auth.
  await expect(t.query(api.getSomething, { foo: "foo" })).rejects.toThrow("Unauthenticated");
  await expect(t.withIdentity({ tokenIdentifier: "bar" }).query(api.getSomething, { foo: "foo" })).rejects.toThrow(
    "User not found",
  );

  // And works with it.
  expect(await authed.query(api.unvalidatedArgsQuery, {})).toMatchObject({
    user: { _id: userId, tokenIdentifier: "foo" },
  });
  expect(await authed.query(api.getSomething, { foo: "foo" })).toEqual(["foo", userId]);
  await authed.mutation(api.create, { tokenIdentifier: "foo", sessionId: "bar" });
  await expect(authed.mutation(api.create, { tokenIdentifier: "bar", sessionId: "bar" })).rejects.toThrow(
    "insert access not allowed",
  );
  await expect(authed.mutation(api.create, { tokenIdentifier: "bar", sessionId: "" })).rejects.toThrow("No session ID");
});

test("custom functions with api auth", async () => {
  const apiKey = "foo";
  const t = make({ API_KEY: apiKey });
  await t.mutation(api.fnCalledFromMyBackend, { apiKey, tokenIdentifier: "bar" });
  await expect(t.mutation(api.fnCalledFromMyBackend, { apiKey: "", tokenIdentifier: "bar" })).rejects.toThrow(
    "Invalid API key",
  );
  // The api key is the customization's: the handler's insert got only its own args.
  const users = await t.run(async (ctx: any) => ctx.db.query("users").collect());
  expect(users.map((u: any) => Object.keys(u).sort())).toEqual([["_creationTime", "_id", "tokenIdentifier"]]);
});

describe("custom functions", () => {
  test("noop", async () => {
    const t = make();
    expect(await t.query(api.noopQuery, { foo: "x" })).toEqual({ bar: "x" });
    expect(await t.mutation(api.noopMutation, { foo: "x" })).toEqual({
      bar: "x",
      roomsIsGetter: true,
      canBroadcast: true,
    });
    expect(await t.action(api.noopAction, { foo: "x" })).toEqual({ bar: "x" });
  });

  test("add args", async () => {
    const t = make();
    expect(await t.query(api.add, {})).toEqual({ argsA: "hi" });
    expect(await t.query(api.addUnverified, {})).toEqual({ argsA: "hi" });
    expect(await t.query(api.addUnverified2, {})).toEqual({ argsA: "hi" });
  });

  test("add ctx", async () => {
    const t = make();
    expect(await t.query(api.addC, {})).toEqual({ ctxA: "hi" });
    expect(await t.query(api.addCU, {})).toEqual({ ctxA: "hi" });
    expect(await t.query(api.addCU2, {})).toEqual({ ctxA: "hi" });
    expect(await t.query(api.addCU3, { foo: 123 })).toEqual({ ctxA: "hi" });
    expect(await t.query(api.addCtxWithExistingArg, { b: "foo" })).toEqual({ ctxA: "hi", argB: "foo" });
  });

  test("consume arg, add to ctx", async () => {
    const t = make();
    expect(await t.query(api.consume, { a: "foo" })).toEqual({ ctxA: "foo", argKeys: [] });
  });

  test("pass through arg + ctx", async () => {
    const t = make();
    expect(await t.query(api.passThrough, { a: "foo" })).toEqual({ ctxA: "foo", argsA: "foo" });
  });

  test("modify arg type", async () => {
    const t = make();
    expect(await t.query(api.modify, { a: "foo" })).toEqual({ ctxA: "foo", argsA: 123 });
  });

  test("redefine arg", async () => {
    const t = make();
    expect(await t.query(api.redefine, { a: "foo" })).toEqual({ argsA: "foo" });
  });

  test("refined arg", async () => {
    const t = make();
    expect(await t.query(api.refined, { a: "foo" })).toEqual({ argsA: "foo" });
    await expect(t.query(api.refined, { a: undefined as any })).rejects.toThrow(
      "ArgumentValidationError: Object is missing the required field `a`",
    );
  });

  test("still validates args", async () => {
    const t = make();
    await expect(t.query(api.redefine, { a: 3 as any })).rejects.toThrow(
      "ArgumentValidationError: Value does not match validator",
    );
    // The customization's args too, though only `input` reads them.
    await expect(t.query(api.consume, {})).rejects.toThrow(
      "ArgumentValidationError: Object is missing the required field `a`",
    );
  });
});

describe("nested custom functions", () => {
  test("add args and ctx", async () => {
    const t = make();
    expect(await t.query(api.outerAdds, { a: "hi", outer: "outer" })).toEqual({
      ctxInner: "inner",
      ctxOuter: "outer",
      a: "hi",
      outer: "outer",
    });
  });

  test("remove args", async () => {
    const t = make();
    // Upstream checks `toStrictEqual({ a: "hi" })`: convex-test turns the result into a value, which drops the
    // `undefined` field; `bunvexTest` hands back the handler's object as it is, so the field is there, undefined.
    expect(await t.query(api.outerRemoved, { a: "hi", outer: "bye" })).toEqual({ a: "hi" });
  });

  test("still validates args", async () => {
    const t = make();
    await expect(t.query(api.outerAdds, { a: 3 as any, outer: "" })).rejects.toThrow(
      "ArgumentValidationError: Value does not match validator",
    );
  });
});

describe("extra args", () => {
  test("add extra args", async () => {
    const t = make();
    // `extraArg` reaches `input` only: it is neither an arg of the function nor of the handler.
    expect(await t.query(api.extraArgQuery, { a: "foo" })).toEqual({ ctxA: "foo", argKeys: ["a"] });
    await expect(t.query(api.extraArgQuery, { a: "foo", extraArg: "bar" })).rejects.toThrow(
      "ArgumentValidationError: Object contains extra field `extraArg`",
    );
  });
});

describe("onSuccess", () => {
  test("query: called with the result, the args without the customization's, and the original ctx", async () => {
    const t = make();
    await expect(t.query(api.querySucceeds, { tag: "t1", n: 7 })).rejects.toThrow(
      `onSuccess: ${JSON.stringify({ tag: "t1", result: { success: true, foo: "bar", n: 7 }, args: { n: 7 }, ctxHasFoo: false })}`,
    );
  });

  test("query: not called when the handler throws", async () => {
    const t = make();
    const err = await t.query(api.queryThrows, { tag: "t2" }).catch((e: Error) => e.message);
    expect(err).toContain("Test error");
    expect(err).not.toContain("onSuccess");
  });

  test("mutation: called with the result", async () => {
    const t = make();
    expect(await t.mutation(api.mutationSucceeds, {})).toEqual({ updated: true, foo: "bar" });
    expect(await t.query(api.calls, {})).toEqual([{ kind: "mutation", result: { updated: true, foo: "bar" } }]);
    await expect(t.mutation(api.mutationThrows, {})).rejects.toThrow("Test error");
    expect(await t.query(api.calls, {})).toHaveLength(1);
  });

  test("action: called with the result, not when the handler throws", async () => {
    const t = make();
    expect(await t.action(api.actionSucceeds, {})).toEqual({ executed: true, foo: "bar" });
    expect(await t.query(api.calls, {})).toEqual([{ kind: "action", result: { executed: true, foo: "bar" } }]);
    await expect(t.action(api.actionThrows, {})).rejects.toThrow("Test error");
    // An action's writes are not rolled back: a call after the throw would show here.
    expect(await t.query(api.calls, {})).toHaveLength(1);
  });
});
