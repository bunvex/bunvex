// What `{ ...ctx, ...added }` does in convex-helpers' server modules, without reading `ctx`'s getters (STUDY-181 §3.2):
// a bunvex mutation's `ctx.rooms` is a getter that builds its broadcaster on first use (AD-42), and a spread would
// build it on every merge. Shared by `customFunctions` and `triggers`; not a subpath of the package.

/**
 * `{ ...base, ...patch }`, except that `base`'s getters stay getters (read from `base` when the handler reads them),
 * so a lazy member of `ctx` such as a mutation's `rooms` is not built by the merge. Assigning to one of them makes it
 * a plain property, as on a spread copy.
 */
export function overlay(base: object, patch: object | undefined): Record<PropertyKey, unknown> {
  const out: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(base)) {
    const d = Object.getOwnPropertyDescriptor(base, key);
    if (!d?.enumerable) continue;
    const get = d.get;
    if (get) {
      Object.defineProperty(out, key, {
        enumerable: true,
        configurable: true,
        get: () => get.call(base),
        set(value: unknown) {
          Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
        },
      });
    } else {
      Object.defineProperty(out, key, { value: d.value, writable: true, enumerable: true, configurable: true });
    }
  }
  if (patch !== null && patch !== undefined) {
    for (const key of Reflect.ownKeys(patch)) {
      if (!Object.getOwnPropertyDescriptor(patch, key)?.enumerable) continue;
      const value = (patch as Record<PropertyKey, unknown>)[key];
      Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return out;
}
