// The paginated hooks' arguments (STUDY-65 G-C14, G-C15), as Convex's `react/use_paginated_query.test.tsx`
// checks them for both of its hooks (the classic one and `usePaginatedQuery_experimental`): a bad
// `initialNumItems` throws Convex's message, and the hook starts over on a new function or new arguments, but
// not on equal arguments built anew. Differential: each case runs with `@bunvex/react`'s hooks and with the
// official `convex/react` ones (the oracle), under each library's provider, over the same fake client.
import { afterEach, expect, spyOn, test } from "bun:test";
import { anyApi, getFunctionName } from "@bunvex/client";
import {
  BunvexProvider,
  type BunvexReactClient,
  usePaginatedQuery,
  usePaginatedQuery_experimental,
} from "@bunvex/react";
import { cleanup, renderHook } from "@testing-library/react";
import * as oracle from "convex/react";
import { anyApi as oracleApi, getFunctionName as oracleFunctionName } from "convex/server";
import type { ReactNode } from "react";

afterEach(() => cleanup());

/** A client whose watches never load; it records which (function, arguments) are listened to. */
function fakeClient() {
  const watches: { name: string; args: Record<string, unknown>; listeners: number }[] = [];
  const nameOf = (q: unknown) => {
    try {
      return getFunctionName(q as never);
    } catch {
      return oracleFunctionName(q as never);
    }
  };
  const watch = (query: unknown, args: Record<string, unknown>) => {
    const w = { name: nameOf(query), args, listeners: 0 };
    watches.push(w);
    return {
      onUpdate: () => {
        w.listeners++;
        return () => {
          w.listeners--;
        };
      },
      localQueryResult: () => undefined,
      localQueryLogs: () => undefined,
      journal: () => undefined,
    };
  };
  return {
    logger: { log() {}, warn() {}, error() {}, logVerbose() {} },
    watchQuery: (q: unknown, args: Record<string, unknown>) => watch(q, args),
    watchPaginatedQuery: (q: unknown, args: Record<string, unknown>) => watch(q, args),
    /** What is listened to now, as `name(args without paginationOpts)`. */
    listened: () =>
      watches
        .filter((w) => w.listeners > 0)
        .map((w) => {
          const { paginationOpts: _, ...rest } = w.args;
          return `${w.name}(${JSON.stringify(rest)})`;
        }),
    created: () => watches.length,
  };
}

type Hook = (query: unknown, args: unknown, options: unknown) => unknown;
const variants: {
  name: string;
  hook: Hook;
  api: Record<string, Record<string, unknown>>;
  wrap: (c: unknown) => (p: { children?: ReactNode }) => ReactNode;
}[] = [];
const bunvexWrap = (c: unknown) => (p: { children?: ReactNode }) => (
  <BunvexProvider client={c as BunvexReactClient}>{p.children}</BunvexProvider>
);
const oracleWrap = (c: unknown) => (p: { children?: ReactNode }) => (
  <oracle.ConvexProvider client={c as oracle.ConvexReactClient}>{p.children}</oracle.ConvexProvider>
);
variants.push(
  { name: "@bunvex/react usePaginatedQuery", hook: usePaginatedQuery as never, api: anyApi, wrap: bunvexWrap },
  {
    name: "@bunvex/react usePaginatedQuery_experimental",
    hook: usePaginatedQuery_experimental as never,
    api: anyApi,
    wrap: bunvexWrap,
  },
  {
    name: "convex/react usePaginatedQuery (oracle)",
    hook: oracle.usePaginatedQuery as never,
    api: oracleApi,
    wrap: oracleWrap,
  },
  {
    name: "convex/react usePaginatedQuery_experimental (oracle)",
    hook: oracle.usePaginatedQuery_experimental as never,
    api: oracleApi,
    wrap: oracleWrap,
  },
);

const badOptions: [string, unknown, string][] = [
  ["no options", undefined, "undefined"],
  ["{}", {}, "undefined"],
  ["-1", { initialNumItems: -1 }, "-1"],
  ['"wrongType"', { initialNumItems: "wrongType" }, "wrongType"],
];

for (const v of variants) {
  for (const [what, options, received] of badOptions)
    test(`${v.name}: options ${what} throws Convex's message (G-C14)`, () => {
      const quiet = spyOn(console, "error").mockImplementation(() => {});
      try {
        let thrown: unknown;
        try {
          renderHook(() => v.hook(v.api.m!.list, {}, options), { wrapper: v.wrap(fakeClient()) });
        } catch (e) {
          thrown = e;
        }
        expect(String(thrown)).toBe(
          `Error: \`options.initialNumItems\` must be a positive number. Received \`${received}\`.`,
        );
      } finally {
        quiet.mockRestore();
      }
    });

  test(`${v.name}: a new function or new arguments start over; equal arguments built anew do not (G-C15)`, () => {
    const client = fakeClient();
    let args: [unknown, Record<string, unknown>] = [v.api.m!.list, {}];
    const { rerender } = renderHook(() => v.hook(args[0], args[1], { initialNumItems: 10 }), {
      wrapper: v.wrap(client),
    });
    expect(client.listened()).toEqual(["m:list({})"]);
    args = [v.api.m!.list2, {}];
    rerender();
    expect(client.listened()).toEqual(["m:list2({})"]);
    args = [v.api.m!.list2, { someArg: 123 }];
    rerender();
    expect(client.listened()).toEqual(['m:list2({"someArg":123})']);
    const before = client.created();
    const listener = client.listened();
    args = [v.api.m!.list2, { someArg: 123 }];
    rerender();
    expect(client.listened()).toEqual(listener);
    // Rendering may read local results (a watch each), but no new subscription is made.
    expect(client.listened()).toHaveLength(1);
    expect(client.created() - before).toBeLessThanOrEqual(3);
  });
}
