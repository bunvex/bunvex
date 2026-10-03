// usePreloadedQuery against a real bunvex server (STUDY-46): the first render is the payload's value, with no
// loading state, then the hook follows the live subscription.
import { afterEach, describe, expect, test } from "bun:test";
import type { AnyFunctionReference } from "@bunvex/client";
import { anyApi } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient, type Preloaded, usePreloadedQuery } from "@bunvex/react";
import { toJsonValue, type Value } from "@bunvex/values";
import { act, render, screen } from "@testing-library/react";
import { startServer } from "../test/harness.ts";

const api = anyApi;
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const cleanup: (() => unknown)[] = [];

/** The payload `preloadQuery` returns (its shape is checked against convex/nextjs in test/nextjs.test.ts). */
const payload = (name: string, args: Value, value: Value) =>
  ({ _name: name, _argsJSON: toJsonValue(args), _valueJSON: toJsonValue(value) }) as unknown as Preloaded<
    AnyFunctionReference & { _type: "query" }
  >;
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe("usePreloadedQuery", () => {
  test("renders the preloaded value first, then every change", async () => {
    const h = await startServer();
    cleanup.push(h.stop);
    const client = new BunvexReactClient(h.url, {
      logger: false,
      webSocketConstructor: BunWebSocket,
      unsavedChangesWarning: false,
    });
    cleanup.push(() => client.close());
    await client.mutation(api.messages.send, { body: "a" });
    const preloaded = payload("messages:list", {}, ["a"]);
    const renders: unknown[] = [];
    function List(props: { preloaded: Preloaded<AnyFunctionReference> }) {
      const list = usePreloadedQuery(props.preloaded) as string[];
      renders.push(list);
      return <p>{list.join(",")}</p>;
    }
    render(
      <BunvexProvider client={client}>
        <List preloaded={preloaded} />
      </BunvexProvider>,
    );
    // The very first render already has the server's value: no `undefined`.
    expect(renders[0]).toEqual(["a"]);
    expect(screen.getByText("a")).toBeTruthy();
    await act(() => client.mutation(api.messages.send, { body: "b" }));
    await screen.findByText("a,b");
    expect(renders).not.toContain(undefined);
  });

  test("the live subscription runs with the payload's (decoded) arguments", async () => {
    const h = await startServer();
    cleanup.push(h.stop);
    const client = new BunvexReactClient(h.url, {
      logger: false,
      webSocketConstructor: BunWebSocket,
      unsavedChangesWarning: false,
    });
    cleanup.push(() => client.close());
    // A stale server value: only the subscription, run with `{ x: 41n }`, can turn it into 41n.
    const stale = payload("messages:echoQuery", { x: 41n }, 0n);
    function Echo() {
      const x = usePreloadedQuery(stale) as bigint;
      return <p>{`got ${typeof x} ${x}`}</p>;
    }
    render(
      <BunvexProvider client={client}>
        <Echo />
      </BunvexProvider>,
    );
    expect(screen.getByText("got bigint 0")).toBeTruthy();
    await screen.findByText("got bigint 41");
  });
});
