// A stand-in deployment for a real `BunvexReactClient` (STUDY-208 §5): its auth and query calls are spied on instance by
// instance, so a test says when the server accepts or drops the token and what a query answers, and nothing connects.
// It takes the place of upstream's `vi.mock("convex/react")`: bun's `mock.module` is process-wide in a run, and would
// reach the suites that use the real hooks.
import { spyOn } from "bun:test";
import type { BunvexReactClient } from "@bunvex/react";
import { getFunctionName } from "@bunvex/server";
import { act } from "@testing-library/react";

export function stubDeployment(client: BunvexReactClient) {
  let onAuthChange: ((accepted: boolean) => void) | undefined;
  const results = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const subscriptions: Array<{ path: string; args: unknown }> = [];

  const setAuth = spyOn(client, "setAuth").mockImplementation((_fetchToken, onChange) => {
    onAuthChange = onChange;
  });
  const clearAuth = spyOn(client, "clearAuth").mockImplementation(() => {
    onAuthChange = undefined;
  });
  spyOn(client, "watchQuery").mockImplementation(((
    query: Parameters<BunvexReactClient["watchQuery"]>[0],
    args: unknown,
  ) => {
    const path = getFunctionName(query);
    return {
      onUpdate: (callback: () => void) => {
        subscriptions.push({ path, args });
        const set = listeners.get(path) ?? new Set();
        listeners.set(path, set);
        set.add(callback);
        return () => set.delete(callback);
      },
      localQueryResult: () => results.get(path),
      localQueryLogs: () => undefined,
      journal: () => undefined,
    };
  }) as never);

  return {
    setAuth,
    clearAuth,
    /** The server's answer to the token the client authenticated with (the client must have called `setAuth`). */
    accept(accepted: boolean) {
      if (onAuthChange === undefined) throw new Error("the client has not authenticated");
      const onChange = onAuthChange;
      act(() => onChange(accepted));
    },
    /** A query's next answer, pushed to its subscribers. */
    serve(path: string, value: unknown) {
      results.set(path, value);
      act(() => {
        for (const callback of listeners.get(path) ?? []) callback();
      });
    },
    /** The subscriptions opened to `path`, in order, with their arguments. */
    subscriptionsTo: (path: string) => subscriptions.filter((s) => s.path === path),
    /** Whether `path` has a live subscriber. */
    isSubscribed: (path: string) => (listeners.get(path)?.size ?? 0) > 0,
  };
}
