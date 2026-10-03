// The Clerk and Auth0 providers (STUDY-47), differential: Convex's `convex/react-clerk` and `convex/react-auth0`
// (the oracle) and `@bunvex/react-clerk` / `@bunvex/react-auth0` run the same app against the same bunvex server,
// with each library's hook faked. Both must ask the library for the same tokens (Convex's "convex" template and
// audience are "bunvex" here, DV-242) and reach the same auth states.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import * as bunvex from "@bunvex/react";
import { createServer, Functions, query } from "@bunvex/server";
import { v } from "@bunvex/values";
import { act, render, screen, cleanup as unmountAll, waitFor } from "@testing-library/react";
import * as convex from "convex/react";
import { type ReactNode, useSyncExternalStore } from "react";
import { startIssuer } from "../test/issuer.ts";

// Auth0's hook, faked for both providers (they import `useAuth0` from the SDK).
let auth0Hook: () => unknown = () => {
  throw new Error("no fake Auth0 in this test");
};
mock.module("@auth0/auth0-react", () => ({ useAuth0: () => auth0Hook() }));
const { BunvexProviderWithAuth0 } = await import("@bunvex/react-auth0");
const { BunvexProviderWithClerk } = await import("@bunvex/react-clerk");
const { ConvexProviderWithAuth0 } = await import("convex/react-auth0");
const { ConvexProviderWithClerk } = await import("convex/react-clerk");

const api = anyApi;
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const BunFetch = (globalThis as { BunFetch?: typeof fetch }).BunFetch!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  unmountAll(); // first: unmounting signs out, which needs the client still open
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A tiny store a fake library's hook reads, so tests can change its state. */
function store<S extends object>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<S>) {
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    use: () =>
      useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => state,
      ),
  };
}

/** Library modes: `stale` hands out a token the server refuses unless the cache is skipped; `down` throws. */
type Mode = "ok" | "stale" | "down";

/** A fake Clerk `useAuth`: every `getToken` call is recorded. */
function fakeClerk(sign: (claims: Record<string, unknown>) => Promise<string>) {
  const s = store({
    isLoaded: false,
    isSignedIn: undefined as boolean | undefined,
    sessionClaims: null as Record<string, unknown> | null,
    orgId: null as string | null,
    mode: "ok" as Mode,
  });
  const calls: { template?: string; skipCache?: boolean }[] = [];
  const getToken = async (options: { template?: string; skipCache?: boolean }) => {
    calls.push({ ...options });
    const { mode } = s.get();
    if (mode === "down") throw new Error("Clerk is down");
    return sign(mode === "stale" && !options.skipCache ? { aud: "elsewhere" } : { sub: "ada" });
  };
  function useAuth() {
    const state = s.use();
    return {
      isLoaded: state.isLoaded,
      isSignedIn: state.isSignedIn,
      getToken,
      orgId: state.orgId,
      orgRole: null,
      sessionId: "sess_1",
      sessionClaims: state.sessionClaims,
    };
  }
  return { ...s, calls, useAuth };
}

/** A fake Auth0 `useAuth0`: every `getAccessTokenSilently` call is recorded; the ID token is the one to use. */
function fakeAuth0(sign: (claims: Record<string, unknown>) => Promise<string>) {
  const s = store({ isLoading: true, isAuthenticated: false, mode: "ok" as Mode });
  const calls: Record<string, unknown>[] = [];
  const getAccessTokenSilently = async (options: { cacheMode?: string; detailedResponse?: boolean }) => {
    calls.push({ ...options });
    const { mode } = s.get();
    if (mode === "down") throw new Error("Auth0 is down");
    const id_token = await sign(
      mode === "stale" && options.cacheMode !== "off" ? { aud: "elsewhere" } : { sub: "ada" },
    );
    // The access token is for another API: only the ID token is accepted.
    return { id_token, access_token: await sign({ aud: "some-api" }), expires_in: 3600 };
  };
  function useAuth0() {
    const state = s.use();
    return { isLoading: state.isLoading, isAuthenticated: state.isAuthenticated, getAccessTokenSilently };
  }
  return { ...s, calls, useAuth0 };
}

const stacks = [
  {
    name: "convex",
    Client: convex.ConvexReactClient,
    clientOptions: { skipConvexDeploymentUrlCheck: true },
    WithClerk: ConvexProviderWithClerk,
    WithAuth0: ConvexProviderWithAuth0,
    useAuthState: convex.useConvexAuth,
    useQuery: convex.useQuery,
  },
  {
    name: "bunvex",
    Client: bunvex.BunvexReactClient,
    clientOptions: {},
    WithClerk: BunvexProviderWithClerk,
    WithAuth0: BunvexProviderWithAuth0,
    useAuthState: bunvex.useBunvexAuth,
    useQuery: bunvex.useQuery,
  },
] as const;

for (const s of stacks)
  describe(`Clerk and Auth0 providers: ${s.name}`, () => {
    /** Convex's template and audience name is "convex"; bunvex's is "bunvex" (DV-242). */
    const NAME = s.name;

    async function setup() {
      const issuer = await startIssuer({ cacheControl: "max-age=600" });
      cleanup.push(issuer.stop);
      const engine = await new Engine(
        defineSchema({ notes: defineTable(v.any()) }),
        await MemoryPersistence.open(null, { durable: false }),
      ).init();
      const functions = new Functions(engine).register("notes", {
        whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
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
      const states: string[] = [];
      function State() {
        const a = s.useAuthState();
        const label = a.isLoading ? "loading" : a.isAuthenticated ? "authenticated" : "unauthenticated";
        if (states.at(-1) !== label) states.push(label);
        return <span data-testid="state">{label}</span>;
      }
      function Who() {
        const who = (s.useQuery as (q: unknown, a: object) => unknown)(api.notes.whoami, {});
        return <span data-testid="who">{who === undefined ? "…" : String(who)}</span>;
      }
      const sign = (claims: Record<string, unknown>) => issuer.sign(claims);
      return { client, states, State, Who, sign };
    }

    describe("Clerk", () => {
      async function clerkApp() {
        const t = await setup();
        const clerk = fakeClerk(t.sign);
        const mount = (children?: ReactNode) =>
          render(
            <s.WithClerk client={t.client as never} useAuth={clerk.useAuth as never}>
              <t.State />
              {children}
            </s.WithClerk>,
          );
        return { ...t, clerk, mount };
      }

      test("signed in: a token from the template, and the identity reaches ctx.auth", async () => {
        const { clerk, states, mount, Who } = await clerkApp();
        mount(<Who />);
        expect(screen.getByTestId("state").textContent).toBe("loading");
        act(() => clerk.set({ isLoaded: true, isSignedIn: true }));
        await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
        expect(states).toEqual(["loading", "authenticated"]);
        expect(clerk.calls[0]).toEqual({ template: NAME, skipCache: false });
      });

      test(`a session token already for the deployment (aud "${NAME}"): no template`, async () => {
        const { clerk, mount, Who } = await clerkApp();
        clerk.set({ isLoaded: true, isSignedIn: true, sessionClaims: { aud: NAME } });
        mount(<Who />);
        await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
        expect(clerk.calls[0]).toEqual({ skipCache: false });
      });

      test("a cached token the server refuses: fetched again skipping Clerk's cache", async () => {
        const { clerk, mount, Who } = await clerkApp();
        clerk.set({ isLoaded: true, isSignedIn: true, mode: "stale" });
        mount(<Who />);
        await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
        expect(clerk.calls.slice(0, 2)).toEqual([
          { template: NAME, skipCache: false },
          { template: NAME, skipCache: true },
        ]);
      });

      test("signed out: unauthenticated, no token asked", async () => {
        const { clerk, states, mount } = await clerkApp();
        clerk.set({ isLoaded: true, isSignedIn: false });
        mount();
        await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
        expect(clerk.calls).toEqual([]);
      });

      test("getToken throws: no token, so unauthenticated", async () => {
        const { clerk, states, mount } = await clerkApp();
        clerk.set({ isLoaded: true, isSignedIn: true, mode: "down" });
        mount();
        await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
        expect(clerk.calls.length).toBeGreaterThan(0);
      });

      test("another organization: a new token is fetched", async () => {
        const { clerk, mount, Who } = await clerkApp();
        clerk.set({ isLoaded: true, isSignedIn: true, orgId: "org_1" });
        mount(<Who />);
        await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
        const before = clerk.calls.length;
        act(() => clerk.set({ orgId: "org_2" }));
        await waitFor(() => expect(clerk.calls.length).toBeGreaterThan(before));
        await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("authenticated"));
      });
    });

    describe("Auth0", () => {
      async function auth0App() {
        const t = await setup();
        const auth0 = fakeAuth0(t.sign);
        auth0Hook = auth0.useAuth0;
        const mount = (children?: ReactNode) =>
          render(
            <s.WithAuth0 client={t.client as never}>
              <t.State />
              {children}
            </s.WithAuth0>,
          );
        return { ...t, auth0, mount };
      }

      test("signed in: the ID token (not the access token), from the cache, reaches ctx.auth", async () => {
        const { auth0, states, mount, Who } = await auth0App();
        mount(<Who />);
        expect(screen.getByTestId("state").textContent).toBe("loading");
        act(() => auth0.set({ isLoading: false, isAuthenticated: true }));
        await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
        expect(states).toEqual(["loading", "authenticated"]);
        expect(auth0.calls[0]).toEqual({ detailedResponse: true, cacheMode: "on" });
      });

      test("a cached token the server refuses: fetched again with the cache off", async () => {
        const { auth0, mount, Who } = await auth0App();
        auth0.set({ isLoading: false, isAuthenticated: true, mode: "stale" });
        mount(<Who />);
        await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("ada"));
        expect(auth0.calls.slice(0, 2)).toEqual([
          { detailedResponse: true, cacheMode: "on" },
          { detailedResponse: true, cacheMode: "off" },
        ]);
      });

      test("signed out: unauthenticated, no token asked", async () => {
        const { auth0, states, mount } = await auth0App();
        auth0.set({ isLoading: false, isAuthenticated: false });
        mount();
        await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
        expect(auth0.calls).toEqual([]);
      });

      test("getAccessTokenSilently throws: no token, so unauthenticated", async () => {
        const { auth0, states, mount } = await auth0App();
        auth0.set({ isLoading: false, isAuthenticated: true, mode: "down" });
        mount();
        await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
        expect(auth0.calls.length).toBeGreaterThan(0);
      });
    });
  });
