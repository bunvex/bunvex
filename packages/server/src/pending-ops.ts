// An action's operations that are not on its `ctx` (STUDY-143): `createFunctionHandle` and `log.audit` are module
// functions, and count as pending until they settle under Convex's names for their syscalls (`name_when_dangling`:
// `createFunctionHandle`, `auditLog`), as `ctx`'s calls do. The tracker is the server's (`functions.ts`); outside an
// action, or without one, the operation just runs.
type Tracker = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

let tracker: Tracker | null = null;

/** Set by the server: how an operation of the running action is counted. */
export function setOperationTracker(t: Tracker | null) {
  tracker = t;
}

/** `fn`'s promise, pending under `name` for the running action (if any) until it settles. */
export function trackedOperation<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracker ? tracker(name, fn) : fn();
}
