// React auth (STUDY-27 §1.7), differential: the same app runs on Convex's `convex/react` (the oracle) and on
// `@bunvex/react`, against the same bunvex server, with an auth library faked by a small store.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import * as bunvex from "@bunvex/react";
import { createServer, Functions, query } from "@bunvex/server";
import { v } from "@bunvex/values";
import { act, render, renderHook, screen, cleanup as unmountAll, waitFor } from "@testing-library/react";
import * as convex from "convex/react";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { startIssuer } from "../test/issuer.ts";

const api = anyApi;
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const BunFetch = (globalThis as { BunFetch?: typeof fetch }).BunFetch!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  unmountAll(); // first: unmounting signs out, which needs the client still open
  for (const f of cleanup.splice(0).reverse()) await f();
});

type AuthState = { isLoading: boolean; isAuthenticated: boolean; claims: Record<string, unknown> };
/** A fake auth library: its state, and the token it hands out (claims per user). */
function authLibrary(sign: (claims: Record<string, unknown>) => Promise<string>) {
  let state: AuthState = { isLoading: true, isAuthenticated: false, claims: { sub: "ada" } };
  const listeners = new Set<() => void>();
  let n = 0;
  return {
    set(next: Omit<AuthState, "claims">, claims?: Record<string, unknown>) {
      state = { ...next, claims: claims ?? state.claims };
      for (const l of listeners) l();
    },
    useAuth() {
      const s = useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => state,
      );
      // A new fetcher per user, as a real library's (e.g. another organization) is a new auth context.
      const fetchAccessToken = useCallback(async () => sign({ ...s.claims, jti: `t${n++}` }), [s.claims, sign]);
      return { isLoading: s.isLoading, isAuthenticated: s.isAuthenticated, fetchAccessToken };
    },
  };
}

/** The two stacks, under one shape. */
const stacks = [
  {
    name: "convex/react",
    Client: convex.ConvexReactClient,
    clientOptions: { skipConvexDeploymentUrlCheck: true },
    ProviderWithAuth: convex.ConvexProviderWithAuth,
    useAuthState: convex.useConvexAuth,
    useQuery: convex.useQuery,
    Authenticated: convex.Authenticated,
    Unauthenticated: convex.Unauthenticated,
    AuthLoading: convex.AuthLoading,
  },
  {
    name: "@bunvex/react",
    Client: bunvex.BunvexReactClient,
    clientOptions: {},
    ProviderWithAuth: bunvex.BunvexProviderWithAuth,
    useAuthState: bunvex.useBunvexAuth,
    useQuery: bunvex.useQuery,
    Authenticated: bunvex.Authenticated,
    Unauthenticated: bunvex.Unauthenticated,
    AuthLoading: bunvex.AuthLoading,
  },
] as const;

for (const s of stacks)
  describe(`auth in React: ${s.name}`, () => {
    async function setup() {
      const issuer = await startIssuer({ cacheControl: "max-age=600" });
      cleanup.push(issuer.stop);
      const engine = await new Engine(
        defineSchema({ notes: defineTable(v.any()) }),
        await MemoryPersistence.open(null, { durable: false }),
      ).init();
      // Every identity the query ran as: a signed-in app's query must never run signed out.
      const ranAs: (string | null)[] = [];
      const functions = new Functions(engine).register("notes", {
        whoami: query(async ({ auth }) => {
          const me = (await auth.getUserIdentity())?.subject ?? null;
          ranAs.push(me);
          return me;
        }),
      });
      const server = createServer({
        engine,
        functions,
        port: 0,
        authFetch: BunFetch,
        auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
      });
      cleanup.push(server.stop);
      const client = new s.Client(`http://127.0.0.1:${server.server.port}`, {
        ...s.clientOptions,
        logger: false,
        webSocketConstructor: BunWebSocket,
        unsavedChangesWarning: false,
      } as never);
      cleanup.push(() => client.close());
      const lib = authLibrary((c) => issuer.sign(c));
      const states: string[] = [];
      function State() {
        const a = s.useAuthState();
        const label = a.isLoading ? "loading" : a.isAuthenticated ? "authenticated" : "unauthenticated";
        if (states.at(-1) !== label) states.push(label);
        return null;
      }
      function Who() {
        const who = (s.useQuery as (q: unknown, a: object) => unknown)(api.notes.whoami, {});
        return <span data-testid="who">{who === undefined ? "…" : String(who)}</span>;
      }
      const app = (children: ReactNode) => (
        <s.ProviderWithAuth client={client as never} useAuth={lib.useAuth}>
          <State />
          {children}
        </s.ProviderWithAuth>
      );
      return { client, lib, states, ranAs, app, Who };
    }

    test("loading → authenticated once the server accepts the token; the query never runs signed out", async () => {
      const { lib, states, ranAs, app, Who } = await setup();
      render(
        app(
          <>
            <s.AuthLoading>
              <span data-testid="gate">loading</span>
            </s.AuthLoading>
            <s.Authenticated>
              <span data-testid="gate">in</span>
              <Who />
            </s.Authenticated>
            <s.Unauthenticated>
              <span data-testid="gate">out</span>
            </s.Unauthenticated>
          </>,
        ),
      );
      expect(screen.getByTestId("gate").textContent).toBe("loading");
      act(() => lib.set({ isLoading: false, isAuthenticated: true }));
      await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
      expect(screen.getByTestId("gate").textContent).toBe("in");
      // Signing out: Authenticated's children unsubscribe before clearAuth, so nothing re-runs signed out.
      act(() => lib.set({ isLoading: false, isAuthenticated: false }));
      await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("out"));
      await Bun.sleep(100);
      expect(states).toEqual(["loading", "authenticated", "unauthenticated"]);
      expect(ranAs.includes(null)).toBe(false);
    });

    test("a query mounted with the provider runs first as the user (setAuth before children subscribe)", async () => {
      const { lib, ranAs, app, Who } = await setup();
      lib.set({ isLoading: false, isAuthenticated: true });
      render(app(<Who />));
      await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
      expect(ranAs[0]).toBe("ada");
    });

    test("a token the server refuses: loading, then unauthenticated", async () => {
      const { lib, states, app } = await setup();
      lib.set({ isLoading: false, isAuthenticated: true }, { aud: "elsewhere" });
      render(app(null));
      await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
      expect(states).toEqual(["loading", "unauthenticated"]);
    });

    test("a new token fetcher (another auth context) goes back to loading, then authenticated as the new user", async () => {
      const { lib, states, app, Who } = await setup();
      lib.set({ isLoading: false, isAuthenticated: true });
      render(app(<Who />));
      await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
      act(() => lib.set({ isLoading: false, isAuthenticated: true }, { sub: "bob" }));
      await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("bob"));
      await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
      expect(states).toEqual(["loading", "authenticated", "loading", "authenticated"]);
    });

    test("the auth hook outside its provider throws", () => {
      expect(() => renderHook(() => s.useAuthState())).toThrow("as an ancestor component");
    });
  });
