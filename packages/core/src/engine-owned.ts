// Test mode (TEST-01): the values the engine keeps are frozen, so code that mutates one — a function given the
// engine's own object instead of a copy, a commit listener changing a version others read — throws at once
// instead of silently changing stored data. Convex gets this from its architecture (values cross into the
// function's isolate as copies); bunvex runs both in one process, so every crossing must copy. Off by
// default: BUNVEX_FREEZE_ENGINE_VALUES=1 turns it on (the test runs set it).
export const FREEZE_ENGINE_VALUES = process.env.BUNVEX_FREEZE_ENGINE_VALUES === "1";

/** `v`, deep-frozen when the test mode is on (bytes are left as they are: a buffer's contents cannot freeze). */
export function engineOwned<T>(v: T): T {
  if (FREEZE_ENGINE_VALUES) deepFreeze(v);
  return v;
}

function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== "object" || Object.isFrozen(v) || v instanceof ArrayBuffer || ArrayBuffer.isView(v))
    return;
  Object.freeze(v);
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) deepFreeze(x);
}
