// The React client's logger (STUDY-65 F5), as Convex's `ConvexReactClient`: it builds a `Logger` from its
// `logger` option (`false`: nowhere; a logger: that one; else the console), `client.logger` returns it, and the
// paginated hooks warn through it when they reset after an InvalidCursor error. bunvex used to return the raw
// option and warn with `console.warn`, so `logger: false` did not silence the warning and a custom logger never
// got it. The hooks are checked against the official ones (the oracle) over the same fake client.
import { afterEach, expect, spyOn, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient, usePaginatedQuery, usePaginatedQuery_experimental } from "@bunvex/react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as oracle from "convex/react";
import { anyApi as oracleApi } from "convex/server";
import type { ReactNode } from "react";

afterEach(() => cleanup());

const recording = () => {
  const lines: [string, string][] = [];
  const at =
    (level: string) =>
    (...a: unknown[]) =>
      lines.push([level, a.map(String).join(" ")]);
  return { lines, logger: { logVerbose: at("verbose"), log: at("log"), warn: at("warn"), error: at("error") } };
};

test("client.logger: the one passed; a silent one for `false`; the console otherwise", () => {
  const mine = recording();
  const custom = new BunvexReactClient("http://127.0.0.1:1", { logger: mine.logger });
  expect(custom.logger).toBe(mine.logger);

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    new BunvexReactClient("http://127.0.0.1:1", { logger: false }).logger.warn("quiet");
    expect(warn).not.toHaveBeenCalled();
    new BunvexReactClient("http://127.0.0.1:1").logger.warn("loud");
    new BunvexReactClient("http://127.0.0.1:1", { logger: true }).logger.warn("loud too");
    expect(warn.mock.calls).toEqual([["loud"], ["loud too"]]);
  } finally {
    warn.mockRestore();
  }
});

/**
 * A client for the hooks: every paginated page fails with InvalidCursor until the logger hears the reset, then
 * answers an empty, finished page. `logger` is what the hook should warn through.
 */
function fakeClient(logger: ReturnType<typeof recording>["logger"]) {
  let failing = true;
  const reset = {
    ...logger,
    warn: (...a: unknown[]) => {
      failing = false;
      logger.warn(...a);
    },
  };
  const watch = (paginated: boolean) => ({
    onUpdate: () => () => {},
    localQueryLogs: () => undefined,
    journal: () => undefined,
    localQueryResult: () => {
      if (failing) throw new Error("InvalidCursor: the data under the cursor changed");
      return paginated
        ? { results: [], status: "Exhausted", loadMore: () => false }
        : { page: [], isDone: true, continueCursor: "end" };
    },
  });
  return {
    logger: reset,
    watchQuery: () => watch(false),
    watchPaginatedQuery: () => watch(true),
  };
}

const RESET =
  "usePaginatedQuery hit error, resetting pagination state: InvalidCursor: the data under the cursor changed";

const hooks = [
  {
    name: "@bunvex/react usePaginatedQuery",
    wrap: (c: unknown) => (p: { children?: ReactNode }) => (
      <BunvexProvider client={c as BunvexReactClient}>{p.children}</BunvexProvider>
    ),
    use: () => usePaginatedQuery(anyApi.m.list as never, {}, { initialNumItems: 3 }),
  },
  {
    name: "@bunvex/react usePaginatedQuery_experimental",
    wrap: (c: unknown) => (p: { children?: ReactNode }) => (
      <BunvexProvider client={c as BunvexReactClient}>{p.children}</BunvexProvider>
    ),
    use: () => usePaginatedQuery_experimental(anyApi.m.list as never, {}, { initialNumItems: 3 }),
  },
  {
    name: "convex/react usePaginatedQuery (oracle)",
    wrap: (c: unknown) => (p: { children?: ReactNode }) => (
      <oracle.ConvexProvider client={c as oracle.ConvexReactClient}>{p.children}</oracle.ConvexProvider>
    ),
    use: () => oracle.usePaginatedQuery(oracleApi.m.list as never, {} as never, { initialNumItems: 3 }),
  },
];

for (const hook of hooks)
  test(`${hook.name}: the InvalidCursor reset warns through the client's logger, not the console`, async () => {
    const mine = recording();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { result } = renderHook(() => hook.use(), { wrapper: hook.wrap(fakeClient(mine.logger)) });
      await waitFor(() => expect(mine.lines.length).toBeGreaterThan(0));
      expect(mine.lines[0]).toEqual(["warn", RESET]);
      expect(warn).not.toHaveBeenCalled();
      await waitFor(() => expect(result.current.status).toBe("Exhausted"));
    } finally {
      warn.mockRestore();
    }
  });
