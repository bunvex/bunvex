// `useQueries` and the observer behind it (STUDY-65 G-C12), as Convex's `react/queries_observer.test.ts` and
// `react/use_queries.test.ts` pin them, and differential: every scenario runs with `@bunvex/react` and with the
// official `convex/react` (the oracle), each under its own provider, over the same fake client. The fake hands
// out watches the test drives, so what is subscribed, and when, is visible.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, getFunctionName } from "@bunvex/client";
import { BunvexProvider, type BunvexReactClient, useQueries } from "@bunvex/react";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as oracle from "convex/react";
import { anyApi as oracleApi, getFunctionName as oracleFunctionName } from "convex/server";
import type { ReactNode } from "react";

afterEach(() => cleanup());

/** A watch the test drives, as Convex's `FakeWatch`: its journal is dropped once no one listens. */
class FakeWatch {
  callbacks = new Set<() => void>();
  value: unknown;
  error: Error | undefined;
  journalValue: string | undefined;
  constructor(
    readonly name: string,
    readonly args: unknown,
    readonly options: Record<string, unknown>,
  ) {}
  set(value: unknown) {
    this.value = value;
    for (const c of this.callbacks) c();
  }
  fail(error: Error) {
    this.error = error;
    for (const c of this.callbacks) c();
  }
  onUpdate(callback: () => void) {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
      if (this.callbacks.size === 0) this.journalValue = undefined;
    };
  }
  localQueryResult() {
    if (this.error) throw this.error;
    return this.value;
  }
  localQueryLogs() {
    return undefined;
  }
  journal() {
    return this.journalValue;
  }
}

/**
 * The client both libraries' `useQueries` call: `watchQuery` (and `watchPaginatedQuery`) hand out watches that
 * share a value per function and arguments, as the real client's local results do.
 */
class FakeClient {
  watches: FakeWatch[] = [];
  values = new Map<string, unknown>();
  errors = new Map<string, Error>();
  private key = (name: string, args: unknown) => `${name}:${JSON.stringify(args)}`;
  private nameOf(query: unknown) {
    // Each library's references answer its own `getFunctionName`.
    try {
      return getFunctionName(query as never);
    } catch {
      return oracleFunctionName(query as never);
    }
  }
  watchQuery(query: unknown, args: unknown, options: Record<string, unknown> = {}) {
    const name = this.nameOf(query);
    const w = new FakeWatch(name, args, options);
    w.value = this.values.get(this.key(name, args));
    w.error = this.errors.get(this.key(name, args));
    this.watches.push(w);
    return w;
  }
  watchPaginatedQuery(query: unknown, args: unknown, options: Record<string, unknown>) {
    return this.watchQuery(query, args, { paginationOptions: options });
  }
  /** The watches someone listens to, as `name(args)`. */
  subscribed() {
    return this.watches.filter((w) => w.callbacks.size > 0).map((w) => `${w.name}(${JSON.stringify(w.args)})`);
  }
  /** A function and arguments fail: every listened watch of it updates. */
  fail(name: string, args: unknown, error: Error) {
    this.errors.set(this.key(name, args), error);
    for (const w of this.watches)
      if (w.name === name && JSON.stringify(w.args) === JSON.stringify(args) && w.callbacks.size > 0) w.fail(error);
  }
  /** A value arrives for a function and arguments: every listened watch of it updates. */
  set(name: string, args: unknown, value: unknown) {
    this.values.set(this.key(name, args), value);
    for (const w of this.watches)
      if (w.name === name && JSON.stringify(w.args) === JSON.stringify(args) && w.callbacks.size > 0) w.set(value);
  }
}

type Requests = Record<string, { query: unknown; args: Record<string, unknown>; paginationOptions?: unknown }>;
type Lib = {
  name: string;
  api: Record<string, Record<string, unknown>>;
  wrap(client: FakeClient): (props: { children?: ReactNode }) => ReactNode;
  useQueries(queries: Requests): Record<string, unknown>;
};
const libs: Lib[] = [
  {
    name: "@bunvex/react",
    api: anyApi as never,
    wrap: (client) => (props) => (
      <BunvexProvider client={client as unknown as BunvexReactClient}>{props.children}</BunvexProvider>
    ),
    useQueries: (q) => useQueries(q as never),
  },
  {
    name: "convex/react (oracle)",
    api: oracleApi as never,
    wrap: (client) => (props) => (
      <oracle.ConvexProvider client={client as unknown as oracle.ConvexReactClient}>
        {props.children}
      </oracle.ConvexProvider>
    ),
    useQueries: (q) => oracle.useQueries(q as never),
  },
];

for (const lib of libs)
  describe(`useQueries: ${lib.name}`, () => {
    const { api } = lib;
    const q1 = api.m!.one!;
    const q2 = api.m!.two!;
    /** Render `useQueries(queries())`; `queries` is read on each render, as a component would compute it. */
    function mount(client: FakeClient, queries: () => Requests) {
      return renderHook(() => lib.useQueries(queries()), { wrapper: lib.wrap(client) });
    }

    test("a local result is there on the first render", () => {
      const client = new FakeClient();
      client.values.set("m:one:{}", "ready");
      const seen: unknown[] = [];
      // The requests object is stable across renders, as Convex's hook requires (`useQuery` memoizes it).
      const queries: Requests = { a: { query: q1, args: {} } };
      const { result } = renderHook(
        () => {
          const r = lib.useQueries(queries);
          seen.push(r.a);
          return r;
        },
        { wrapper: lib.wrap(client) },
      );
      expect(seen[0]).toBe("ready");
      expect(result.current).toEqual({ a: "ready" });
    });

    test("a query loads; a second one added later loads on its own; the first keeps its value", () => {
      const client = new FakeClient();
      let queries: Requests = { a: { query: q1, args: {} } };
      const { result, rerender } = mount(client, () => queries);
      expect(result.current).toEqual({ a: undefined });
      act(() => client.set("m:one", {}, "one"));
      expect(result.current).toEqual({ a: "one" });

      queries = { a: { query: q1, args: {} }, b: { query: q2, args: {} } };
      rerender();
      expect(result.current).toEqual({ a: "one", b: undefined });
      expect(client.subscribed().sort()).toEqual(["m:one({})", "m:two({})"]);
      act(() => client.set("m:two", {}, "two"));
      expect(result.current).toEqual({ a: "one", b: "two" });
    });

    test("another function or other arguments under the same identifier: only the new one stays subscribed", () => {
      const client = new FakeClient();
      let queries: Requests = { a: { query: q1, args: { n: 1 } } };
      const { rerender } = mount(client, () => queries);
      expect(client.subscribed()).toEqual(['m:one({"n":1})']);
      queries = { a: { query: q1, args: { n: 2 } } };
      rerender();
      expect(client.subscribed()).toEqual(['m:one({"n":2})']);
      queries = { a: { query: q2, args: { n: 2 } } };
      rerender();
      expect(client.subscribed()).toEqual(['m:two({"n":2})']);
    });

    test("an equal request built anew keeps the one subscription", () => {
      const client = new FakeClient();
      const build = (): Requests => ({ a: { query: q1, args: { s: "x", n: 1, o: {} } } });
      let queries = build();
      const { rerender } = mount(client, () => queries);
      const first = client.watches.find((w) => w.callbacks.size > 0);
      queries = build();
      rerender();
      queries = build();
      rerender();
      const listened = client.watches.filter((w) => w.callbacks.size > 0);
      expect(listened).toHaveLength(1);
      expect(listened[0]).toBe(first!);
    });

    test("an identifier dropped is unsubscribed; unmounting unsubscribes everything", () => {
      const client = new FakeClient();
      let queries: Requests = { a: { query: q1, args: {} }, b: { query: q2, args: {} } };
      const { rerender, unmount } = mount(client, () => queries);
      expect(client.subscribed().sort()).toEqual(["m:one({})", "m:two({})"]);
      queries = { b: { query: q2, args: {} } };
      rerender();
      expect(client.subscribed()).toEqual(["m:two({})"]);
      unmount();
      expect(client.subscribed()).toEqual([]);
    });

    test("a failed query is its Error, the others keep their values", () => {
      const client = new FakeClient();
      const queries: Requests = { a: { query: q1, args: {} }, b: { query: q2, args: {} } };
      const { result } = mount(client, () => queries);
      act(() => client.set("m:two", {}, "fine"));
      act(() => client.fail("m:one", {}, new Error("boom")));
      expect(result.current.a).toBeInstanceOf(Error);
      expect((result.current.a as Error).message).toBe("boom");
      expect(result.current.b).toBe("fine");
    });

    test("a new client: every query moves over with its journal; the old client's watches are dropped", () => {
      const before = new FakeClient();
      const after = new FakeClient();
      let client = before;
      const queries: Requests = { a: { query: q1, args: {} }, b: { query: q2, args: {} } };
      const { rerender } = renderHook(() => lib.useQueries(queries), {
        wrapper: (props: { children?: ReactNode }) => lib.wrap(client)(props),
      });
      for (const w of before.watches) if (w.callbacks.size > 0 && w.name === "m:one") w.journalValue = "j1";
      client = after;
      rerender();
      expect(before.subscribed()).toEqual([]);
      expect(after.subscribed().sort()).toEqual(["m:one({})", "m:two({})"]);
      const moved = after.watches.filter((w) => w.callbacks.size > 0);
      expect(moved.find((w) => w.name === "m:one")!.options).toEqual({ journal: "j1" });
      expect(moved.find((w) => w.name === "m:two")!.options).toEqual({});
    });

    test("paginated requests: new pagination options resubscribe; equal ones do not", () => {
      const client = new FakeClient();
      let queries: Requests = { p: { query: q1, args: {}, paginationOptions: { initialNumItems: 5, id: 1 } } };
      const { rerender } = mount(client, () => queries);
      const first = client.watches.find((w) => w.callbacks.size > 0)!;
      expect(first.options).toEqual({ paginationOptions: { initialNumItems: 5, id: 1 } });
      queries = { p: { query: q1, args: {}, paginationOptions: { initialNumItems: 5, id: 1 } } };
      rerender();
      expect(client.watches.filter((w) => w.callbacks.size > 0)).toEqual([first]);
      queries = { p: { query: q1, args: {}, paginationOptions: { initialNumItems: 5, id: 2 } } };
      rerender();
      const now = client.watches.filter((w) => w.callbacks.size > 0);
      expect(now).toHaveLength(1);
      expect(now[0]!.options).toEqual({ paginationOptions: { initialNumItems: 5, id: 2 } });
    });
  });
