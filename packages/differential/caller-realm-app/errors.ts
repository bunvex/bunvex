// The app of test/caller-realm.test.ts: nested calls (to the app's own functions and to a component) whose callee
// throws, caught by the caller, which reports what it sees of the error in its own realm.
import { actionGeneric, componentsGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError } from "convex/values";

const components = componentsGeneric() as any;

const fail = (data: boolean) => {
  if (data) throw new ConvexError({ code: "APP", n: 1 });
  throw new Error("app boom");
};

export const throwingQuery = queryGeneric(async (_ctx, { data }: { data: boolean }) => fail(data));
export const throwingMutation = mutationGeneric(async (_ctx, { data }: { data: boolean }) => fail(data));

const throwingQueryRef = makeFunctionReference<"query">("errors:throwingQuery");
const throwingMutationRef = makeFunctionReference<"mutation">("errors:throwingMutation");

/** What the caller sees of the error it caught, in its own realm. */
function seen(e: any) {
  const stack = typeof e?.stack === "string" ? e.stack : null;
  return {
    instanceofError: e instanceof Error,
    instanceofAppError: e instanceof ConvexError,
    prototypeIsError: Object.getPrototypeOf(e) === Error.prototype,
    prototypeIsAppError: Object.getPrototypeOf(e) === ConvexError.prototype,
    constructorName: e?.constructor?.name ?? null,
    constructorIsError: e?.constructor === Error,
    name: e?.name ?? null,
    message: e?.message ?? null,
    data: e?.data === undefined ? "undefined" : e.data,
    ownKeys: Object.getOwnPropertyNames(e).sort(),
    toStringTag: Object.prototype.toString.call(e),
    // The caller's own frame (where it called, or awaited, the call); the frames themselves are not compared.
    stackHasCaller: stack !== null && /errors\.(ts|js)/.test(stack),
    stack,
  };
}

async function caught(call: () => Promise<unknown>) {
  try {
    await call();
    return null;
  } catch (e) {
    return seen(e);
  }
}

/** A query calling a query. */
export const queryToQuery = queryGeneric(async (ctx, { data }: { data: boolean }) =>
  caught(() => ctx.runQuery(throwingQueryRef, { data })),
);
/** A mutation calling a query. */
export const mutationToQuery = mutationGeneric(async (ctx, { data }: { data: boolean }) =>
  caught(() => ctx.runQuery(throwingQueryRef, { data })),
);
/** An action calling a mutation. */
export const actionToMutation = actionGeneric(async (ctx, { data }: { data: boolean }) =>
  caught(() => ctx.runMutation(throwingMutationRef, { data })),
);
/** The app's query calling its component's query. */
export const queryToComponent = queryGeneric(async (ctx, { data }: { data: boolean }) =>
  caught(() => ctx.runQuery(components.thrower.lib.boomQuery, { data })),
);
/** The app's mutation calling its component's mutation. */
export const mutationToComponent = mutationGeneric(async (ctx, { data }: { data: boolean }) =>
  caught(() => ctx.runMutation(components.thrower.lib.boomMutation, { data })),
);
/** The app's action calling its component's mutation. */
export const actionToComponent = actionGeneric(async (ctx, { data }: { data: boolean }) =>
  caught(() => ctx.runMutation(components.thrower.lib.boomMutation, { data })),
);
/** The app's own application error and a plain one, made in its realm: the baseline. */
export const ownErrors = queryGeneric(async (_ctx, { data }: { data: boolean }) => caught(async () => fail(data)));

/** Refused before the callee runs (no such function): from a query, and from an action. */
const missingRef = makeFunctionReference<"query">("errors:missing");
export const queryToMissing = queryGeneric(async (ctx) => caught(() => ctx.runQuery(missingRef, {})));
export const actionToMissing = actionGeneric(async (ctx) => caught(() => ctx.runQuery(missingRef, {})));
