// Package @bunvex/nextjs — Next.js and server rendering (STUDY-46), the counterpart of Convex's `convex/nextjs`:
// `fetchQuery`, `fetchMutation` and `fetchAction` for Server Components, Server Actions and Route Handlers, and
// `preloadQuery`, whose payload a Client Component renders with `@bunvex/react`'s `usePreloadedQuery`.
import {
  type AnyFunctionReference,
  type ArgsAndOptions,
  BunvexHttpClient,
  type FunctionReturnType,
  getFunctionName,
} from "@bunvex/client";
import type { Preloaded } from "@bunvex/react";
import { fromJsonValue, type JSONValue, toJsonValue, type Value } from "@bunvex/values";

type Ref<T extends "query" | "mutation" | "action"> = AnyFunctionReference & { _type: T };

/** Options of `preloadQuery`, `fetchQuery`, `fetchMutation` and `fetchAction`. */
export type NextjsOptions = {
  /** The JWT-encoded OpenID Connect token to call the function with. */
  token?: string;
  /**
   * The deployment's URL. Defaults to `process.env.NEXT_PUBLIC_BUNVEX_URL`. Passing `undefined` explicitly (an
   * unset environment variable) warns, and will throw in the future, as Convex.
   */
  url?: string;
  /** @internal An admin key to call the function with. */
  adminToken?: string;
  /** Skip checking that the URL is an absolute http(s) URL (default `false`). */
  skipDeploymentUrlCheck?: boolean;
};

/** Run a query and return a `Preloaded` payload for `usePreloadedQuery` in a Client Component. */
export async function preloadQuery<Query extends Ref<"query">>(
  query: Query,
  ...args: ArgsAndOptions<Query, NextjsOptions>
): Promise<Preloaded<Query>> {
  const value = await fetchQuery(query, ...args);
  const preloaded = {
    _name: getFunctionName(query),
    _argsJSON: toJsonValue((args[0] ?? {}) as Value),
    _valueJSON: toJsonValue(value as Value),
  };
  return preloaded as unknown as Preloaded<Query>;
}

/** The query result a `preloadQuery` payload holds. */
export function preloadedQueryResult<Query extends Ref<"query">>(
  preloaded: Preloaded<Query>,
): FunctionReturnType<Query> {
  return fromJsonValue(preloaded._valueJSON as unknown as JSONValue) as FunctionReturnType<Query>;
}

/** Run a query. */
export async function fetchQuery<Query extends Ref<"query">>(
  query: Query,
  ...args: ArgsAndOptions<Query, NextjsOptions>
): Promise<FunctionReturnType<Query>> {
  const [fnArgs, options] = args;
  return setupClient(options ?? {}).query(query, (fnArgs || {}) as never);
}

/** Run a mutation. */
export async function fetchMutation<Mutation extends Ref<"mutation">>(
  mutation: Mutation,
  ...args: ArgsAndOptions<Mutation, NextjsOptions>
): Promise<FunctionReturnType<Mutation>> {
  const [fnArgs, options] = args;
  return setupClient(options ?? {}).mutation(mutation, (fnArgs || {}) as never);
}

/** Run an action. */
export async function fetchAction<Action extends Ref<"action">>(
  action: Action,
  ...args: ArgsAndOptions<Action, NextjsOptions>
): Promise<FunctionReturnType<Action>> {
  const [fnArgs, options] = args;
  return setupClient(options ?? {}).action(action, (fnArgs || {}) as never);
}

/** A new HTTP client per call, its requests never cached by Next.js (`cache: "no-store"`). */
function setupClient(options: NextjsOptions) {
  if ("url" in options && options.url === undefined) {
    // An error in the future, as Convex.
    console.error(
      "deploymentUrl is undefined, are your environment variables set? In the future explicitly passing undefined will cause an error. To explicitly use the default, pass `process.env.NEXT_PUBLIC_BUNVEX_URL`.",
    );
  }
  const client = new BunvexHttpClient(deploymentUrl(options.url), {
    skipDeploymentUrlCheck: options.skipDeploymentUrlCheck ?? false,
  });
  if (options.token !== undefined) client.setAuth(options.token);
  if (options.adminToken !== undefined) client.setAdminAuth(options.adminToken);
  client.setFetchOptions({ cache: "no-store" });
  return client;
}

function deploymentUrl(url: string | undefined): string {
  const fromEnv = url === undefined;
  const address = url ?? process.env.NEXT_PUBLIC_BUNVEX_URL;
  if (typeof address !== "string")
    throw new Error(
      fromEnv
        ? "Environment variable NEXT_PUBLIC_BUNVEX_URL is not set."
        : "Function called with invalid deployment address.",
    );
  return address;
}
