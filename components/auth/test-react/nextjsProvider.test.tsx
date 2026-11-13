// `BunvexAuthNextjsProvider` (STUDY-202 §1.8): upstream's `ssr/nextjs/oauth.test.tsx`, the two cases that need no
// provider's hook, ported with the inert `oauth()` client and a stand-in provider (the third, a flow started on the
// backend client, comes with OAuth); and the provider's own wiring: the server's token adopted, refresh and sign-out
// posted to the app's routes, and the session watcher on the query the prop names (STUDY-208 §1.10). A real
// `BunvexReactClient` on a made-up URL, its calls stubbed, so it never connects; the routes answer through a stubbed
// `fetch`.
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { BunvexReactClient } from "@bunvex/react";
import { act, cleanup, render } from "@testing-library/react";
import { InMemoryStorage } from "../src/browser/storage.ts";
import { makeSlimBundle } from "../src/lib/types.ts";
import { useAuthActions, useAuthToken } from "../src/react/index.tsx";
import { BunvexAuthNextjsProvider } from "../src/ssr/nextjs/client.tsx";
import { stubDeployment } from "./deployment.ts";
import { acmeRefs, bundle, NAMESPACE, seedPendingFlow, waitFor } from "./oauthFlow.ts";

const slim = makeSlimBundle(bundle);

/** The app's routes, answering through `fetch`: the sign-in route in the HTTP client's format, the others `{ tokens }`. */
function stubRoutes(signInValue: unknown, tokens: unknown = null) {
  return spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith("/auth/signin") ? { status: "success", value: signInValue, logLines: [] } : { tokens };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
}

const clients: BunvexReactClient[] = [];
/** A real client whose calls reject unless a test sets a result: nothing reaches a deployment. */
function makeClient() {
  const client = new BunvexReactClient(NAMESPACE);
  clients.push(client);
  const mutation = spyOn(client, "mutation").mockRejectedValue(new Error("unexpected backend call"));
  spyOn(client, "action").mockRejectedValue(new Error("unexpected backend call"));
  // Auth and queries: nothing is accepted or answered unless a test says so.
  const deployment = stubDeployment(client);
  return { client, mutation, deployment };
}

let fetchSpy: Mock<typeof fetch> | undefined;
beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(async () => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  for (const c of clients.splice(0)) await c.close();
});

describe("OAuth under BunvexAuthNextjsProvider", () => {
  test("a callback code redeems through the proxy and signs in", async () => {
    window.history.replaceState(null, "", "/signin?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, acmeRefs);
    fetchSpy = stubRoutes({ status: "complete", tokens: slim });
    const { client, mutation } = makeClient();
    let token: string | null = null;
    function Probe() {
      token = useAuthToken();
      return null;
    }
    render(
      <BunvexAuthNextjsProvider client={client} storage={storage} isAuthenticatedFunctionName="auth:isAuthenticated">
        <Probe />
      </BunvexAuthNextjsProvider>,
    );
    await waitFor(() => expect(token).toBe(bundle.accessToken));
    expect(mutation).not.toHaveBeenCalled();
    const signIns = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith("/auth/signin"));
    expect(signIns).toHaveLength(1);
    const [url, init] = signIns[0]!;
    expect(url).toBe("/auth/signin?path=/api/mutation");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      path: "auth:completeSignInWithAcme",
      format: "encoded_json",
      args: [{ code: "code-1", state: "state-1" }],
    });
    expect(window.location.search).toBe("");
  });

  test("stripping the callback params also updates Next's router", async () => {
    // Next keeps `__NA` in the history state of the entries its router owns.
    window.history.replaceState({ __NA: true }, "", "/signin?bunvexAuthCode=code-1");
    const stripped = new URL("/signin", window.location.href).href;
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, acmeRefs);
    fetchSpy = stubRoutes({ status: "complete", tokens: slim });
    const { client } = makeClient();
    const replaceState = spyOn(window.history, "replaceState");
    try {
      render(
        <BunvexAuthNextjsProvider client={client} storage={storage} isAuthenticatedFunctionName="auth:isAuthenticated">
          {null}
        </BunvexAuthNextjsProvider>,
      );
      // First: the parameters gone, Next's state kept.
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenLastCalledWith({ __NA: true }, "", stripped);
      // Then, with no state, so Next's patched `replaceState` updates its router.
      await waitFor(() => expect(replaceState).toHaveBeenLastCalledWith(null, "", stripped));
    } finally {
      replaceState.mockRestore();
    }
  });
});

describe("BunvexAuthNextjsProvider", () => {
  test("the server's access token is the session's once the client starts", async () => {
    const { client } = makeClient();
    fetchSpy = stubRoutes(null);
    let token: string | null = "unset";
    function Probe() {
      token = useAuthToken();
      return null;
    }
    render(
      <BunvexAuthNextjsProvider
        client={client}
        storage={new InMemoryStorage()}
        initialToken="from-the-server"
        isAuthenticatedFunctionName="auth:isAuthenticated"
      >
        <Probe />
      </BunvexAuthNextjsProvider>,
    );
    await waitFor(() => expect(token).toBe("from-the-server"));
  });

  test("signing out posts to the sign-out route, and forgets the session", async () => {
    const { client } = makeClient();
    fetchSpy = stubRoutes(null);
    let token: string | null = null;
    let signOut: (() => Promise<void>) | undefined;
    function Probe() {
      token = useAuthToken();
      signOut = useAuthActions().signOut;
      return null;
    }
    render(
      <BunvexAuthNextjsProvider
        client={client}
        storage={new InMemoryStorage()}
        initialToken="from-the-server"
        signOutRoute="/session/out"
        isAuthenticatedFunctionName="auth:isAuthenticated"
      >
        <Probe />
      </BunvexAuthNextjsProvider>,
    );
    await waitFor(() => expect(token).toBe("from-the-server"));
    await signOut!();
    await waitFor(() => expect(token).toBeNull());
    const posted = fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method]);
    expect(posted).toContainEqual(["/session/out", "POST"]);
  });

  test("a session revoked on the server posts to the sign-out route, and forgets the session", async () => {
    const { client, deployment } = makeClient();
    fetchSpy = stubRoutes(null);
    let token: string | null = null;
    function Probe() {
      token = useAuthToken();
      return null;
    }
    render(
      <BunvexAuthNextjsProvider
        client={client}
        storage={new InMemoryStorage()}
        initialToken="from-the-server"
        isAuthenticatedFunctionName="users:hasLiveSession"
      >
        <Probe />
      </BunvexAuthNextjsProvider>,
    );
    await waitFor(() => expect(token).toBe("from-the-server"));
    await waitFor(() => expect(deployment.setAuth).toHaveBeenCalled());
    // The reference is rebuilt from the name, and subscribed once the deployment accepts the token.
    expect(deployment.subscriptionsTo("users:hasLiveSession")).toEqual([]);
    deployment.accept(true);
    expect(deployment.subscriptionsTo("users:hasLiveSession")).toEqual([{ path: "users:hasLiveSession", args: {} }]);
    deployment.serve("users:hasLiveSession", true);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).not.toContain("/auth/signout");

    await act(async () => {
      deployment.serve("users:hasLiveSession", false);
      await waitFor(() => expect(token).toBeNull());
    });
    const posted = fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method]);
    expect(posted).toContainEqual(["/auth/signout", "POST"]);
  });
});
