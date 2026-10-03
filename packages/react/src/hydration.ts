// Server-rendered query values handed to the client, as Convex's `react/hydration.tsx` (STUDY-46): a
// `Preloaded` payload from `@bunvex/nextjs`'s `preloadQuery`, and `usePreloadedQuery`, which renders it until
// the live subscription delivers.
import {
  type AnyFunctionReference,
  type FunctionArgs,
  type FunctionReturnType,
  makeFunctionReference,
} from "@bunvex/client";
import { fromJsonValue, type JSONValue } from "@bunvex/values";
import { useMemo } from "react";
import { useQuery } from "./hooks.ts";

type QueryRef = AnyFunctionReference & { _type: "query" };

/**
 * A query's server-side result, to pass from a Server Component to a Client Component. `_argsJSON` and
 * `_valueJSON` are typed `string`, as Convex's, but hold the JSON values `toJsonValue` makes.
 */
export type Preloaded<Query extends QueryRef> = {
  __type: Query;
  _name: string;
  _argsJSON: string;
  _valueJSON: string;
};

/** The preloaded value on the first render, then the live one; needs `BunvexProvider`, as `useQuery`. */
export function usePreloadedQuery<Query extends QueryRef>(preloadedQuery: Preloaded<Query>): FunctionReturnType<Query> {
  const args = useMemo(
    () => fromJsonValue(preloadedQuery._argsJSON as unknown as JSONValue),
    [preloadedQuery._argsJSON],
  ) as FunctionArgs<Query>;
  const preloadedResult = useMemo(
    () => fromJsonValue(preloadedQuery._valueJSON as unknown as JSONValue),
    [preloadedQuery._valueJSON],
  );
  const result = useQuery(makeFunctionReference<"query">(preloadedQuery._name) as unknown as Query, args);
  return (result === undefined ? preloadedResult : result) as FunctionReturnType<Query>;
}
