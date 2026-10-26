// A handler's arguments (STUDY-189 T4), with Convex's cases from its `server/registration.test.ts` ("argument
// inference"): checked by `tsc` (`bun run typecheck`); each `Equal` must hold and each `@ts-expect-error` must be
// an error. Without an `args` validator the arguments are `DefaultFunctionArgs` (`Record<string, unknown>`), not
// `any`, as Convex's.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import {
  type ApiFromModules,
  type DefaultFunctionArgs,
  type MutationBuilder,
  mutationGeneric,
} from "../../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};
type EmptyObject = Record<string, never>;

// biome-ignore lint/suspicious/noExplicitAny: any data model, as Convex's test
const mutation: MutationBuilder<any, "public"> = mutationGeneric;

const module = {
  inlineNoArg: mutation(() => "result"),
  inlineUntypedArg: mutation((_ctx, { _arg }) => {
    check<Equal<typeof _arg, unknown>>(true);
    return "result";
  }),
  inlineTypedArg: mutation((_ctx, { _arg }: { _arg: string }) => "result"),
  inlineUntypedDefaultArg: mutation((_ctx, { _arg } = { _arg: 1 }) => "result"),
  inlineTypedOptionalDefaultArg: mutation((_ctx, { _arg }: { _arg?: string } = { _arg: "default" }) => "result"),

  configNoArg: mutation({ handler: () => "result" }),
  configValidatorNoArg: mutation({ args: {}, handler: () => "result" }),
  configUntypedArg: mutation({
    handler: (_, { arg }) => {
      check<Equal<typeof arg, unknown>>(true);
      return "result";
    },
  }),
  configTypedArg: mutation({
    handler: (_, { arg }: { arg: string }) => {
      check<Equal<typeof arg, string>>(true);
      return "result";
    },
  }),
  configOptionalValidatorUntypedArg: mutation({
    args: { arg: v.optional(v.string()) },
    handler: (_, { arg }) => {
      check<Equal<typeof arg, string | undefined>>(true);
      return "result";
    },
  }),
  configValidatorTypedArg: mutation({
    args: { arg: v.string() },
    handler: (_, { arg }: { arg: string }) => {
      check<Equal<typeof arg, string>>(true);
      return "result";
    },
  }),
  configUntypedDefaultArg: mutation({
    handler: (_, { arg } = { arg: "default" }) => {
      check<Equal<typeof arg, unknown>>(true);
      return "result";
    },
  }),
  configTypedOptionalDefaultArg: mutation({
    handler: (_, { arg }: { arg?: string } = { arg: "default" }) => {
      check<Equal<typeof arg, string | undefined>>(true);
      return "result";
    },
  }),
};
type API = ApiFromModules<{ module: typeof module }>;

test("a handler without an args validator takes DefaultFunctionArgs", () => {
  check<Equal<DefaultFunctionArgs, Record<string, unknown>>>(true);
  check<Equal<API["module"]["inlineNoArg"]["_args"], EmptyObject>>(true);
  check<Equal<API["module"]["inlineUntypedArg"]["_args"], DefaultFunctionArgs>>(true);
  check<Equal<API["module"]["inlineTypedArg"]["_args"], { _arg: string }>>(true);
  check<Equal<API["module"]["inlineUntypedDefaultArg"]["_args"], DefaultFunctionArgs | EmptyObject>>(true);
  check<Equal<API["module"]["inlineTypedOptionalDefaultArg"]["_args"], DefaultFunctionArgs | EmptyObject>>(true);
  check<Equal<API["module"]["configNoArg"]["_args"], EmptyObject>>(true);
  // biome-ignore lint/complexity/noBannedTypes: Convex's expected type
  check<Equal<API["module"]["configValidatorNoArg"]["_args"], {}>>(true);
  check<Equal<API["module"]["configUntypedArg"]["_args"], DefaultFunctionArgs>>(true);
  check<Equal<API["module"]["configTypedArg"]["_args"], { arg: string }>>(true);
  check<Equal<API["module"]["configOptionalValidatorUntypedArg"]["_args"], { arg?: string }>>(true);
  check<Equal<API["module"]["configValidatorTypedArg"]["_args"], { arg: string }>>(true);
  check<Equal<API["module"]["configUntypedDefaultArg"]["_args"], DefaultFunctionArgs | EmptyObject>>(true);
  check<Equal<API["module"]["configTypedOptionalDefaultArg"]["_args"], DefaultFunctionArgs | EmptyObject>>(true);
  expect(Object.keys(module)).toHaveLength(13);
});

test("an untyped argument is unknown, so it needs a type before use", () => {
  mutation(async (_ctx, { n }) => {
    // @ts-expect-error `unknown` is not a number
    const m: number = n;
    return m;
  });
  mutation({
    handler: async (_ctx, args) => {
      // @ts-expect-error `unknown` is not a string
      const s: string = args.x;
      return s;
    },
  });
  mutation(async (_ctx, { n }: { n: number }) => n + 1);
});
