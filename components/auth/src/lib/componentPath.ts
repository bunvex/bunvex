// A mounted component's path from its reference (STUDY-208 §1.6), v2.0.0's `lib/componentPath.ts` (`91d16264`): the
// sign-in methods pass their component as `authenticatedBy`, and the session records its path.
import { getFunctionAddress } from "@bunvex/server";

// How a reference into a component the app mounts reads: `components.authPassword` is
// `_reference/childComponent/authPassword`.
const CHILD_COMPONENT_PREFIX = "_reference/childComponent/";

/**
 * The path of a component the app mounts, from its reference: `"authPassword"` from `components.authPassword`, and
 * `"parent/child"` from a nested one. A reference only says it points inside a mounted component, so a function of
 * one is not refused: `components.authPassword.public.signIn` gives `"authPassword/public/signIn"`. Throws for anything
 * else (a function of the app, the `components` object itself, a plain object).
 */
export function componentPathOf(component: object): string {
  let reference: string | undefined;
  try {
    reference = (getFunctionAddress(component) as { reference?: string }).reference;
  } catch {
    reference = undefined;
  }
  if (
    reference === undefined ||
    !reference.startsWith(CHILD_COMPONENT_PREFIX) ||
    reference.length === CHILD_COMPONENT_PREFIX.length
  )
    throw new Error("Expected a reference inside a component that the app mounts, such as `components.authPassword`.");
  return reference.slice(CHILD_COMPONENT_PREFIX.length);
}
