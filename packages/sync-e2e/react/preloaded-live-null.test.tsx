// usePreloadedQuery hands over to the live value even when that value is `null` (STUDY-65 G-C27), as Convex's
// `nextjs/nextjs.test.tsx` "returns client result after client loads data" checks it: the preloaded value shows
// until the client has its own result, and a `null` result is a result (not "still loading"). Differential: the
// same payload with bunvex's hook and the official one (the oracle), each over its own client, with no server.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient, usePreloadedQuery } from "@bunvex/react";
import { cleanup, renderHook } from "@testing-library/react";
import * as oracle from "convex/react";
import { anyApi as oracleApi } from "convex/server";
import type { ReactNode } from "react";

afterEach(() => cleanup());

/** A WebSocket that never opens: the clients work locally only. */
class NeverSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  readyState = 0;
  constructor(readonly url: string) {}
  send() {}
  close() {}
}
const options = { webSocketConstructor: NeverSocket as never, unsavedChangesWarning: false };

type Store = { setQuery(...a: unknown[]): void };
type Client = {
  mutation(ref: unknown, args: object, o: { optimisticUpdate: (s: Store) => void }): Promise<unknown>;
  close(): Promise<void>;
};
const libs = [
  {
    name: "@bunvex/react",
    api: anyApi as Record<string, Record<string, unknown>>,
    make: () => new BunvexReactClient("http://127.0.0.1:1", options) as unknown as Client,
    wrap: (c: Client) => (p: { children?: ReactNode }) => (
      <BunvexProvider client={c as never}>{p.children}</BunvexProvider>
    ),
    use: (p: unknown) => usePreloadedQuery(p as never),
  },
  {
    name: "convex/react (oracle)",
    api: oracleApi as Record<string, Record<string, unknown>>,
    make: () => new oracle.ConvexReactClient("http://127.0.0.1:1", options) as unknown as Client,
    wrap: (c: Client) => (p: { children?: ReactNode }) => (
      <oracle.ConvexProvider client={c as never}>{p.children}</oracle.ConvexProvider>
    ),
    use: (p: unknown) => oracle.usePreloadedQuery(p as never),
  },
];

/** What a server's `preloadQuery` hands over: the name and the JSON forms of the arguments and the value. */
const preloaded = { _name: "myQuery:default", _argsJSON: { arg: "something" }, _valueJSON: { x: 42 } };

for (const lib of libs)
  describe(lib.name, () => {
    test("the preloaded value until the client has one", () => {
      const client = lib.make();
      const { result } = renderHook(() => lib.use(preloaded), { wrapper: lib.wrap(client) });
      expect(result.current).toStrictEqual({ x: 42 });
      void client.close();
    });

    test("a live null replaces the preloaded value (G-C27)", () => {
      const client = lib.make();
      void client
        .mutation(
          lib.api.myMutation!.default,
          {},
          {
            optimisticUpdate: (store) => store.setQuery(lib.api.myQuery!.default, { arg: "something" }, null),
          },
        )
        .catch(() => {});
      const { result } = renderHook(() => lib.use(preloaded), { wrapper: lib.wrap(client) });
      expect(result.current).toStrictEqual(null);
      void client.close();
    });
  });
