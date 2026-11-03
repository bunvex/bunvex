// A function reference that keeps its identity while it names the same function (STUDY-201 §1.11), as v2's: a generated
// api builds a new reference object on each property read, so `api.auth.signIn` differs at each render, and a hook with
// it in `useCallback`'s dependencies would return a new callback each render (rerunning a caller's effect each time).
"use client";

import { type FunctionReference, type FunctionType, type FunctionVisibility, getFunctionName } from "@bunvex/server";
import { useMemo } from "react";

/** `reference`, the same object across renders while it names the same function. */
export function useStableFunctionReference<Reference extends FunctionReference<FunctionType, FunctionVisibility>>(
  reference: Reference,
): Reference {
  const name = getFunctionName(reference);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the name identifies the function; an earlier render's reference calls the same one
  return useMemo(() => reference, [name]);
}
