// The session manager (STUDY-201 §3.4), upstream's `browser/sessionManager.test.ts` ported (35), plus the two refusals
// of a session whose shape is not the model's. The tests stub `window` to stand for other runtimes, and put the DOM
// preload's back after each.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeFunctionReference } from "@bunvex/server";
import type { AmbientSignInClient, AuthSignInApi } from "../src/browser/ambientSignInClient.ts";
import { AuthClient, INITIAL_AUTH_STATE, type SpaAuthApi, type SsrAuthApi } from "../src/browser/sessionManager.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from "../src/browser/storage.ts";
import type { RefreshResult, SlimTokenBundle, TokenBundle } from "../src/lib/types.ts";

const NAMESPACE = "https://happy-animal-123.bunvex.example";
// As NamespacedStorage strips it: letters and digits only.
const SUFFIX = "httpshappyanimal123bunvexexample";

const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");
function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
}
function restoreWindow(): void {
  if (ORIGINAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
}

const bundle = (n: number): TokenBundle => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  refreshTokenExpiresAt: 0,
  userId: "user-1",
});
/** A `rotated` refresh carrying `bundle(n)`. */
const rotated = (n: number): RefreshResult => ({ kind: "rotated", tokens: bundle(n) });

function makeClient(authApi: Partial<SpaAuthApi> = {}, storage: TokenStorage = new InMemoryStorage()) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => ({ kind: "noSession" }), signOut: async () => {}, ...authApi },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

function makeSsrClient(
  authApi: Partial<SsrAuthApi> = {},
  storage = new InMemoryStorage(),
  extra: { initialAccessToken?: string | null } = {},
) {
  const client = new AuthClient({
    mode: "ssr",
    authApi: { refreshSession: async () => null, signOut: async () => {}, ...authApi },
    storage,
    storageNamespace: NAMESPACE,
    ...extra,
  });
  return { client, storage };
}

const jwt = `${JWT_STORAGE_KEY}_${SUFFIX}`;
const refreshKey = `${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`;

describe("AuthClient", () => {
  afterEach(restoreWindow);

  test("starts unauthenticated with an empty store", async () => {
    const { client } = makeClient();
    expect(client.getSnapshot()).toMatchObject({ isLoading: true });
    await client.init();
    expect(client.getSnapshot()).toEqual({ isLoading: false, isAuthenticated: false, token: null });
  });

  test("setSession authenticates and persists under namespaced keys", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot()).toEqual({ isLoading: false, isAuthenticated: true, token: "access-1" });
    expect(client.getAccessToken()).toBe("access-1");
    expect(storage.getItem(jwt)).toBe("access-1");
    expect(storage.getItem(refreshKey)).toBe("refresh-1");
  });

  test("hydrates a persisted session on init", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(jwt, "access-1");
    storage.setItem(refreshKey, "refresh-1");
    const { client } = makeClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true, token: "access-1" });
  });

  test("fetchAccessToken returns the cached token without forcing", async () => {
    const refreshSession = mock(async () => rotated(2));
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));
    expect(await client.fetchAccessToken({ forceRefreshToken: false })).toBe("access-1");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  test("forced fetch rotates the session via refreshSession", async () => {
    const refreshSession = mock(async (rt: string) => {
      expect(rt).toBe("refresh-1");
      return rotated(2);
    });
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(storage.getItem(refreshKey)).toBe("refresh-2");
  });

  test("a refresh that fails keeps the stored refresh token for the next try", async () => {
    // The server keeps the token presented valid until its successor is used: a lost answer is retried with it.
    const refreshSession = mock<(rt: string) => Promise<RefreshResult>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(rotated(2));
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));
    await expect(client.fetchAccessToken({ forceRefreshToken: true })).rejects.toThrow("response lost");
    expect(storage.getItem(refreshKey)).toBe("refresh-1");
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe("access-2");
    expect(refreshSession).toHaveBeenNthCalledWith(2, "refresh-1");
    expect(storage.getItem(refreshKey)).toBe("refresh-2");
  });

  test("a noSession refresh result clears the session", async () => {
    const { client, storage } = makeClient({ refreshSession: async () => ({ kind: "noSession" }) });
    await client.init();
    await client.setSession(bundle(1));
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
    expect(storage.getItem(jwt)).toBeNull();
  });

  test("concurrent forced fetches collapse to a single refresh", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const refreshSession = mock(async () => {
      await promise;
      return rotated(2);
    });
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));
    const pending = [1, 2, 3].map(() => client.fetchAccessToken({ forceRefreshToken: true }));
    resolve();
    expect(await Promise.all(pending)).toEqual(["access-2", "access-2", "access-2"]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  test("signOut revokes on the server and clears locally", async () => {
    const signOut = mock(async (rt: string) => {
      expect(rt).toBe("refresh-1");
    });
    const { client } = makeClient({ signOut });
    await client.init();
    await client.setSession(bundle(1));
    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
  });

  test("a sign-out the server fails still signs out here", async () => {
    // Usually a session already gone on the server; the user asked to sign out either way.
    const signOut = mock(async () => {
      throw new Error("network down");
    });
    const { client, storage } = makeClient({ signOut });
    await client.init();
    await client.setSession(bundle(1));
    await expect(client.signOut()).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
    expect(storage.getItem(jwt)).toBeNull();
    expect(storage.getItem(refreshKey)).toBeNull();
  });

  test("syncs sign-out from another tab via storage events", async () => {
    const listeners: ((event: StorageEvent) => void)[] = [];
    const storage = new InMemoryStorage();
    setWindow({
      addEventListener: (_: string, l: (event: StorageEvent) => void) => listeners.push(l),
      removeEventListener: () => {},
    });
    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    // Another tab cleared the access token's key.
    for (const l of listeners) l({ storageArea: storage, key: jwt, newValue: null } as unknown as StorageEvent);
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
  });

  test("works where `window` exists without DOM event APIs (React Native)", async () => {
    // React Native's global object is `window`, without `addEventListener`: following tabs is skipped, not a throw.
    setWindow({ navigator: {} });
    const { client } = makeClient();
    await expect(client.init()).resolves.toBeUndefined();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(() => client.dispose()).not.toThrow();
  });

  test("works where there is no `window` at all (server runtime)", async () => {
    setWindow(undefined);
    const { client } = makeClient();
    await expect(client.init()).resolves.toBeUndefined();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(() => client.dispose()).not.toThrow();
  });

  test("withSignInPending turns loading on while its call is pending", async () => {
    const { client } = makeClient();
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(false);
    const { promise, resolve } = Promise.withResolvers<string>();
    const pending = client.withSignInPending(() => promise);
    expect(client.getSnapshot().isLoading).toBe(true);
    resolve("done");
    expect(await pending).toBe("done");
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("withSignInPending clears loading when the completion throws", async () => {
    const { client } = makeClient();
    await client.init();
    await expect(
      client.withSignInPending(async () => {
        throw new Error("redemption failed");
      }),
    ).rejects.toThrow("redemption failed");
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("overlapping completions keep loading until the last settles", async () => {
    const { client } = makeClient();
    await client.init();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const pending = [client.withSignInPending(() => first.promise), client.withSignInPending(() => second.promise)];
    first.resolve();
    await pending[0];
    expect(client.getSnapshot().isLoading).toBe(true);
    second.resolve();
    await pending[1];
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("re-attaches the storage listener when init runs after dispose", async () => {
    const listeners = new Set<(event: StorageEvent) => void>();
    const storage = new InMemoryStorage();
    setWindow({
      addEventListener: (_: string, l: (event: StorageEvent) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (event: StorageEvent) => void) => listeners.delete(l),
    });
    const { client } = makeClient({}, storage);
    // init and dispose are symmetric and repeatable: init after dispose restores following tabs (React StrictMode
    // drives this; the React bindings' tests cover it end to end).
    await client.init();
    client.dispose();
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(listeners.size).toBe(1);
    for (const l of listeners) l({ storageArea: storage, key: jwt, newValue: null } as unknown as StorageEvent);
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
  });

  test("refuses a session without its refresh token, which could never be rotated", async () => {
    const { client } = makeClient();
    await client.init();
    await expect(client.setSession({ accessToken: "access-1", userId: "user-1" })).rejects.toThrow(
      "[bunvex-auth] Received a session with no refresh token in SPA mode. Without one the session cannot be rotated " +
        "and would expire silently.",
    );
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });
});

/** The mutation behind {@link SIGN_IN_API}. */
const SIGN_IN_MUTATION = mock();
/** The sign-in API every setup below is handed. */
const SIGN_IN_API = { mutation: SIGN_IN_MUTATION, action: mock() } as unknown as AuthSignInApi;
/** A reference for it; its path is never resolved. */
const SIGN_IN_REF = makeFunctionReference<"mutation">("auth:probeSignIn");

function makeClientWithSignIns(signIns: readonly AmbientSignInClient[], storage: TokenStorage = new InMemoryStorage()) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => ({ kind: "noSession" }), signOut: async () => {} },
    storage,
    storageNamespace: NAMESPACE,
    ambientSignIns: { signIns, signInApi: SIGN_IN_API, bunvex: { mutation: mock() } },
  });
  return { client, storage };
}

describe("AuthClient ambient sign-ins", () => {
  test("throws when two sign-ins share an id", () => {
    expect(() =>
      makeClientWithSignIns([
        { id: "oauth", setup: () => {} },
        { id: "oauth", setup: () => {} },
      ]),
    ).toThrow('Ambient sign-in id "oauth" is registered twice; each auth method registers once per BunvexAuthProvider');
  });

  test("throws when a sign-in id is not alphanumeric", () => {
    expect(() => makeClientWithSignIns([{ id: "pass-key", setup: () => {} }])).toThrow(
      'Ambient sign-in id "pass-key" is invalid; ids must be alphanumeric',
    );
  });

  test("scoped value writes land under the sign-in id", () => {
    const { client } = makeClientWithSignIns([
      { id: "oauth", setup: (ctx) => ctx.values.set("actions", "registered") },
    ]);
    expect(client.ambientSignInValues("oauth").get<string>("actions")).toBe("registered");
  });

  test("scoped storage writes land under the sign-in prefix", () => {
    const storage = new InMemoryStorage();
    makeClientWithSignIns(
      [
        {
          id: "oauth",
          setup: (ctx) => {
            void ctx.storage.set("verifier", "v1");
          },
        },
      ],
      storage,
    );
    // The sign-in's prefix first, then the deployment's namespace.
    expect(storage.getItem(new NamespacedStorage(storage, NAMESPACE).key("__bunvexAuthProvider_oauth_verifier"))).toBe(
      "v1",
    );
  });

  test("every setup receives the same sign-in api and client", () => {
    const received: { signInApi: AuthSignInApi; client: AuthClient }[] = [];
    const record: AmbientSignInClient["setup"] = (ctx) => {
      received.push({ signInApi: ctx.signInApi, client: ctx.client });
    };
    const { client } = makeClientWithSignIns([
      { id: "a", setup: record },
      { id: "b", setup: record },
    ]);
    expect(received.map((r) => r.signInApi)).toEqual([SIGN_IN_API, SIGN_IN_API]);
    expect(received[0]!.client).toBe(client);
    expect(received[1]!.client).toBe(client);
  });

  test("onInit callbacks run during init in registration order, before the session loads", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(jwt, "access-1");
    const order: string[] = [];
    const { client } = makeClientWithSignIns(
      [
        // The stored token is not visible yet: the callback runs before the session loads.
        { id: "a", setup: (ctx) => ({ onInit: () => order.push(`a:${ctx.client.getAccessToken()}`) }) },
        { id: "b", setup: () => {} },
        { id: "c", setup: () => ({ onInit: () => order.push("c") }) },
      ],
      storage,
    );
    expect(order).toEqual([]);
    await client.init();
    expect(order).toEqual(["a:null", "c"]);
    expect(client.getAccessToken()).toBe("access-1");
  });

  test("a second init after dispose does not re-run onInit callbacks", async () => {
    const onInit = mock();
    const { client } = makeClientWithSignIns([{ id: "probe", setup: () => ({ onInit }) }]);
    await client.init();
    client.dispose();
    await client.init();
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  test("a withSignInPending call in onInit holds loading past the session load", async () => {
    // What every ambient sign-in does: a sign-in whose call has not finished when init has loaded the session. Without
    // `withSignInPending` the client would read signed out until it finished, sending the user to a sign-in screen.
    const signIn = Promise.withResolvers<void>();
    const pending: Promise<void>[] = [];
    const { client } = makeClientWithSignIns([
      {
        id: "probe",
        setup: (ctx) => ({
          onInit: () => {
            pending.push(
              ctx.client.withSignInPending(async () => {
                await ctx.signInApi.mutation(SIGN_IN_REF as never, {} as never);
                await ctx.client.setSession(bundle(1));
              }),
            );
          },
        }),
      },
    ]);
    SIGN_IN_MUTATION.mockReturnValueOnce(signIn.promise);
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);
    signIn.resolve();
    await Promise.all(pending);
    expect(client.getSnapshot()).toEqual({ isLoading: false, isAuthenticated: true, token: "access-1" });
  });

  test("a throwing onInit callback is logged and doesn't block the rest", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = new InMemoryStorage();
      storage.setItem(jwt, "access-1");
      const order: string[] = [];
      const { client } = makeClientWithSignIns(
        [
          {
            id: "broken",
            setup: () => ({
              onInit: () => {
                throw new Error("boom");
              },
            }),
          },
          { id: "ok", setup: () => ({ onInit: () => order.push("ok") }) },
        ],
        storage,
      );
      await client.init();
      expect(order).toEqual(["ok"]);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]![0])).toBe('[bunvex-auth] onInit for ambient sign-in "broken" threw:');
      expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true, token: "access-1" });
    } finally {
      consoleError.mockRestore();
    }
  });
});

/** An access-only session: what a server-rendering host's integration answers. */
const ssrAuthResult = (n: number): SlimTokenBundle => ({ accessToken: `access-${n}`, userId: "user-1" });

describe("AuthClient (SSR)", () => {
  afterEach(restoreWindow);

  test("setSession adopts an access-only session, storing no refresh token", async () => {
    const { client, storage } = makeSsrClient();
    await client.init();
    await client.setSession(ssrAuthResult(1));
    expect(client.getSnapshot()).toEqual({ isLoading: false, isAuthenticated: true, token: "access-1" });
    expect(storage.getItem(jwt)).toBe("access-1");
    // The refresh token lives in a server-only cookie, never in JS storage.
    expect(storage.getItem(refreshKey)).toBeNull();
  });

  test("hydrates a session from just the access token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(jwt, "access-1");
    const { client } = makeSsrClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true, token: "access-1" });
  });

  test("forced fetch refreshes via the token-less API call", async () => {
    const refreshSession = mock(async () => ssrAuthResult(2));
    const { client, storage } = makeSsrClient({ refreshSession });
    await client.init();
    await client.setSession(ssrAuthResult(1));
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    // No refresh token in JS: the API is called with no arguments (it reads the cookie).
    expect(refreshSession).toHaveBeenCalledWith();
    expect(storage.getItem(jwt)).toBe("access-2");
    expect(storage.getItem(refreshKey)).toBeNull();
  });

  test("a null refresh clears the session", async () => {
    const { client, storage } = makeSsrClient({ refreshSession: async () => null });
    await client.init();
    await client.setSession(ssrAuthResult(1));
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
    expect(storage.getItem(jwt)).toBeNull();
  });

  test("signOut calls the API with no arguments and clears locally", async () => {
    const signOut = mock(async () => {});
    const { client } = makeSsrClient({ signOut });
    await client.init();
    await client.setSession(ssrAuthResult(1));
    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith();
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: false, token: null });
  });

  test("initialAccessToken wins over a persisted token and is stored", async () => {
    // The host may have refreshed for the client: its token is fresher than any stored one.
    const storage = new InMemoryStorage();
    storage.setItem(jwt, "stale-access");
    const { client } = makeSsrClient({}, storage, { initialAccessToken: "access-ssr" });
    await client.init();
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true, token: "access-ssr" });
    expect(storage.getItem(jwt)).toBe("access-ssr");
  });

  test("clears refresh token if present", async () => {
    const refreshSession = mock(async () => ssrAuthResult(2));
    const storage = new InMemoryStorage();
    storage.setItem(refreshKey, "refresh-1");
    const { client } = makeSsrClient({ refreshSession }, storage);
    await client.init();
    await client.fetchAccessToken({ forceRefreshToken: true });
    expect(storage.getItem(refreshKey)).toBe(null);
  });

  test("refuses a refresh token in a server-rendering response, never storing it", async () => {
    const { client, storage } = makeSsrClient();
    await client.init();
    await expect(client.setSession(bundle(1))).rejects.toThrow(
      "[bunvex-auth] Received a refresh token in an SSR response. The auth proxy did not move it into the httpOnly " +
        "cookie; refusing to persist it in browser storage.",
    );
    expect(storage.getItem(refreshKey)).toBeNull();
  });
});

/** A {@link TokenStorage} answering every call with a promise, as on React Native. */
class AsyncTokenStorage implements TokenStorage {
  readonly entries = new Map<string, string>();
  async getItem(key: string) {
    await Promise.resolve();
    return this.entries.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    await Promise.resolve();
    this.entries.set(key, value);
  }
  async removeItem(key: string) {
    await Promise.resolve();
    this.entries.delete(key);
  }
}

describe("AuthClient (async storage)", () => {
  afterEach(restoreWindow);

  test("hydrates a persisted session on init", async () => {
    // What matters on React Native: a session survives a restart.
    const storage = new AsyncTokenStorage();
    storage.entries.set(jwt, "access-1");
    storage.entries.set(refreshKey, "refresh-1");
    const { client } = makeClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toEqual({ isLoading: false, isAuthenticated: true, token: "access-1" });
  });

  test("reports loading until the store resolves", async () => {
    const storage = new AsyncTokenStorage();
    storage.entries.set(jwt, "access-1");
    const { client } = makeClient({}, storage);
    const initialized = client.init();
    // Not "signed out" meanwhile: that flash would send the user to a sign-in screen.
    expect(client.getSnapshot()).toEqual(INITIAL_AUTH_STATE);
    await initialized;
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true });
  });

  test("persists, rotates and clears through the async store", async () => {
    const refreshSession = mock(async (rt: string) => {
      // The rotated token is read back from the store, not only held in memory.
      expect(rt).toBe("refresh-1");
      return rotated(2);
    });
    const storage = new AsyncTokenStorage();
    const { client } = makeClient({ refreshSession }, storage);
    await client.init();
    await client.setSession(bundle(1));
    expect(storage.entries.get(jwt)).toBe("access-1");
    expect(storage.entries.get(refreshKey)).toBe("refresh-1");
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe("access-2");
    expect(storage.entries.get(refreshKey)).toBe("refresh-2");
    await client.signOut();
    expect(storage.entries.size).toBe(0);
  });
});
