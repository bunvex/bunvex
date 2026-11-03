// What the sign-in methods build their hooks with (STUDY-201 §1.11), v2's `react/methods.ts`: internal, not an entry
// point. An ambient sign-in publishes its actions and status from its setup; its hooks read them back here.
"use client";

import { useCallback, useContext, useSyncExternalStore } from "react";
import { AuthClientContext } from "./client.tsx";

export type { AmbientSignInClient, AmbientSignInContext, AuthSignInApi } from "../browser/ambientSignInClient.ts";

/**
 * The value the ambient sign-in `id` published at `key`, kept up to date; `undefined` when nothing is (usually: the
 * sign-in was not passed to the provider's `ambientSignIns`, which a method's hook should report as an error).
 */
export function useAmbientSignInValue<T>(id: string, key: string): T | undefined {
  const client = useContext(AuthClientContext);
  if (client === undefined) throw new Error("useAmbientSignInValue must be used within a <BunvexAuthProvider>.");
  const subscribe = useCallback(
    (listener: () => void) => client.ambientSignInValues(id).subscribe(key, listener),
    [client, id, key],
  );
  // Published already when rendering on a server: the same read serves both snapshots.
  const getSnapshot = useCallback(() => client.ambientSignInValues(id).get<T>(key), [client, id, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
