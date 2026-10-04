// The React client without a server (STUDY-65 G-C9, G-C10, G-C11), as Convex's `react/client.test.tsx`: a
// mutation used straight as an event handler throws a useful error; `useQuery` shows an optimistic value and
// nothing when skipped; an async optimistic update warns; `client.query()` resolves from an optimistic value set
// before or after it is called. Differential: each case runs with BunvexReactClient and with the official
// ConvexReactClient (the oracle), over a socket that never connects.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient, useMutation, useQuery } from "@bunvex/react";
import { act, cleanup, renderHook } from "@testing-library/react";
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

type AnyClient = {
  mutation(
    ref: unknown,
    args: object,
    options?: { optimisticUpdate?: (store: { setQuery(...a: unknown[]): void }) => unknown },
  ): Promise<unknown>;
  query(ref: unknown, args: object): Promise<unknown>;
  close(): Promise<void>;
};
type Lib = {
  name: string;
  /** How the library names a function in its error messages (DV-03, DV-04). */
  word: string;
  api: Record<string, Record<string, unknown>>;
  make(): AnyClient;
  wrap(c: AnyClient): (p: { children?: ReactNode }) => ReactNode;
  useMutation(ref: unknown): (...a: unknown[]) => unknown;
  useQuery(ref: unknown, args?: unknown): unknown;
};
const options = { webSocketConstructor: NeverSocket as never, unsavedChangesWarning: false };
const libs: Lib[] = [
  {
    name: "BunvexReactClient",
    word: "bunvex",
    api: anyApi,
    make: () => new BunvexReactClient("http://127.0.0.1:1", options) as never,
    wrap: (c) => (p) => <BunvexProvider client={c as never}>{p.children}</BunvexProvider>,
    useMutation: (ref) => useMutation(ref as never) as never,
    useQuery: (ref, args) => useQuery(ref as never, args as never),
  },
  {
    name: "official ConvexReactClient",
    word: "Convex",
    api: oracleApi,
    make: () => new oracle.ConvexReactClient("http://127.0.0.1:1", options) as never,
    wrap: (c) => (p) => <oracle.ConvexProvider client={c as never}>{p.children}</oracle.ConvexProvider>,
    useMutation: (ref) => oracle.useMutation(ref as never) as never,
    useQuery: (ref, args) => oracle.useQuery(ref as never, args as never),
  },
];

for (const lib of libs)
  describe(lib.name, () => {
    const setup = () => {
      const client = lib.make();
      const setResult = () =>
        void client
          .mutation(
            lib.api.m!.write,
            {},
            {
              optimisticUpdate: (store) => store.setQuery(lib.api.m!.read, {}, "queryResult"),
            },
          )
          .catch(() => {});
      // The socket never opens, so closing never hears it close: not awaited.
      return { client, setResult, done: () => void client.close() };
    };

    test("a mutation used straight as an event handler throws a useful error (G-C9)", async () => {
      const { client, done } = setup();
      const fakeSyntheticEvent = {
        bubbles: false,
        cancelable: true,
        defaultPrevented: false,
        isTrusted: false,
        nativeEvent: {},
        preventDefault: () => undefined,
        isDefaultPrevented: false,
        stopPropagation: () => undefined,
        isPropagationStopped: false,
        persist: () => undefined,
        timeStamp: 0,
        type: "something",
      };
      const { result } = renderHook(() => lib.useMutation(lib.api.m!.write), { wrapper: lib.wrap(client) });
      expect(() => result.current(fakeSyntheticEvent)).toThrow(
        `${lib.word} function called with SyntheticEvent object.`,
      );
      await done();
    });

    test("useQuery shows an optimistic value, and nothing when skipped", async () => {
      const { client, setResult, done } = setup();
      setResult();
      const shown = renderHook(() => lib.useQuery(lib.api.m!.read, {}), { wrapper: lib.wrap(client) });
      expect(shown.result.current).toBe("queryResult");
      const skipped = renderHook(() => lib.useQuery(lib.api.m!.read, "skip"), { wrapper: lib.wrap(client) });
      expect(skipped.result.current).toBeUndefined();
      await done();
    });

    test("an async optimistic update warns (G-C10)", async () => {
      const { client, done } = setup();
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await act(async () => {
          void client.mutation(lib.api.m!.write, {}, { optimisticUpdate: async () => {} }).catch(() => {});
        });
        expect(warn).toHaveBeenCalledWith(
          "Optimistic update handler returned a Promise. Optimistic updates should be synchronous.",
        );
      } finally {
        warn.mockRestore();
      }
      await done();
    });

    test("query() resolves from an optimistic value set after the call, or before it (G-C11)", async () => {
      const { client, setResult, done } = setup();
      const pending = client.query(lib.api.m!.read, {});
      setResult();
      expect(await pending).toBe("queryResult");
      expect(await client.query(lib.api.m!.read, {})).toBe("queryResult");
      await done();
    });
  });
