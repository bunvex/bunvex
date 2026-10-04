// A query's journal on a client swap (STUDY-65 M9): `useQueries` moves each query to the new client with its
// journal only when there is one, as Convex's `QueriesObserver.setCreateWatch` (`journal ? { journal } : {}`).
// A `null` journal, which the server sends for most queries, used to be passed on, so the new client's `Add`
// carried `journal: null` where the official client's carries none. Differential with the official hook.
import { afterEach, expect, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { BunvexProvider, type BunvexReactClient, useQueries } from "@bunvex/react";
import { cleanup, renderHook } from "@testing-library/react";
import * as oracle from "convex/react";
import { anyApi as oracleApi } from "convex/server";
import type { ReactNode } from "react";

afterEach(() => cleanup());

/** A client whose watches report a fixed journal, and which records the options of every watch. */
function fakeClient(journal: string | null) {
  const options: Record<string, unknown>[] = [];
  return {
    options,
    watchQuery(_query: unknown, _args: unknown, o: Record<string, unknown> = {}) {
      options.push(o);
      return {
        onUpdate: () => () => {},
        localQueryResult: () => undefined,
        localQueryLogs: () => undefined,
        journal: () => journal,
      };
    },
  };
}

const libs = [
  {
    name: "@bunvex/react",
    query: anyApi.m.one,
    wrap: (client: unknown) => (props: { children?: ReactNode }) => (
      <BunvexProvider client={client as BunvexReactClient}>{props.children}</BunvexProvider>
    ),
    useQueries: (q: never) => useQueries(q),
  },
  {
    name: "convex/react (oracle)",
    query: oracleApi.m.one,
    wrap: (client: unknown) => (props: { children?: ReactNode }) => (
      <oracle.ConvexProvider client={client as oracle.ConvexReactClient}>{props.children}</oracle.ConvexProvider>
    ),
    useQueries: (q: never) => oracle.useQueries(q),
  },
];

for (const lib of libs)
  test(`${lib.name}: a new client gets a journal only when there is one`, () => {
    const results: Record<string, unknown>[][] = [];
    for (const journal of [null, "j"]) {
      const before = fakeClient(journal);
      const after = fakeClient(null);
      let client = before;
      const queries = { a: { query: lib.query, args: {} } } as never;
      const { rerender, unmount } = renderHook(() => lib.useQueries(queries), {
        wrapper: (props: { children?: ReactNode }) => lib.wrap(client)(props),
      });
      client = after;
      rerender();
      unmount();
      results.push(after.options);
    }
    // The subscription the swap made (the first watch on the new client that carries options of its own, if any).
    expect(results[0]!.every((o) => !("journal" in o))).toBe(true);
    expect(results[1]!.some((o) => o.journal === "j")).toBe(true);
  });
