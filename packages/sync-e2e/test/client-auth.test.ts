// The client authentication flow (STUDY-27 §1.6), differential: every scenario runs with the official client
// (the oracle) and with BunvexClient, against the same bunvex server, and both must behave the same.
import { afterEach, describe, expect, test } from "bun:test";
import { BunvexClient, type Logger } from "@bunvex/client";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions, mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { until } from "./harness.ts";
import { startIssuer } from "./issuer.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Options = { authRefreshTokenLeewaySeconds?: number; expectAuth?: boolean; initialAuthTokenReuse?: boolean };
type FetchToken = (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;
/** What the scenarios use of either client. */
type AnyClient = {
  onUpdate(ref: unknown, args: object, cb: (v: unknown) => void): { getCurrentValue(): unknown };
  mutation(ref: unknown, args: object): Promise<unknown>;
  setAuth(fetchToken: FetchToken, onChange?: (isAuthenticated: boolean) => void): void;
  getAuth(): { token: string; decoded: Record<string, unknown> } | undefined;
  client: {
    clearAuth(): void;
    setAuth(fetchToken: FetchToken, onChange: (a: boolean) => void, onRefreshChange?: (r: boolean) => void): void;
  };
};

const clients: [string, (url: string, options: Options & { logger: Logger }) => AnyClient][] = [
  ["official client", (url, o) => new ConvexClient(url, { skipConvexDeploymentUrlCheck: true, ...o }) as never],
  [
    "BunvexClient",
    (url, o) => new BunvexClient(url, { webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 100 }, ...o }) as never,
  ],
];

for (const [name, make] of clients)
  describe(`setAuth: ${name}`, () => {
    async function setup(options: Options = {}) {
      const issuer = await startIssuer({ cacheControl: "max-age=600" });
      cleanup.push(issuer.stop);
      const engine = await new Engine(
        defineSchema({ notes: defineTable(v.any()) }),
        await MemoryPersistence.open(null, { durable: false }),
      ).init();
      const functions = new Functions(engine).register("notes", {
        whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
        add: mutation(async ({ db, auth }) => {
          const me = (await auth.getUserIdentity())?.subject ?? null;
          await db.insert("notes", { by: me });
          return me;
        }),
      });
      const server = createServer({
        engine,
        functions,
        port: 0,
        redactLogsToClient: false,
        auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
      });
      cleanup.push(server.stop);
      const errors: string[] = [];
      const logger = { logVerbose() {}, log() {}, warn() {}, error: (...a: unknown[]) => errors.push(a.join(" ")) };
      const c = make(`http://127.0.0.1:${server.server.port}`, { ...options, logger });
      cleanup.push(() => (c as unknown as { close(): Promise<void> }).close());
      // Every fetch is recorded; tokens differ (jti), as an identity provider's do.
      const fetches: boolean[] = [];
      let n = 0;
      const fetcher =
        (claims: Record<string, unknown> | ((n: number) => Record<string, unknown>) = {}): FetchToken =>
        async ({ forceRefreshToken }) => {
          fetches.push(forceRefreshToken);
          const i = n++;
          return issuer.sign({ jti: `t${i}`, ...(typeof claims === "function" ? claims(i) : claims) });
        };
      return { issuer, c, errors, fetches, fetcher };
    }

    test("a cached token, then a fresh one; queries and mutations run as the user", async () => {
      const { c, fetches, fetcher } = await setup();
      const sub = c.onUpdate(api.notes.whoami, {}, () => {});
      const changes: boolean[] = [];
      c.setAuth(fetcher({ sub: "ada" }), (a) => changes.push(a));
      await until(() => sub.getCurrentValue() === "ada", "signed in");
      await until(() => fetches.length === 2, "the fresh token");
      expect(fetches).toEqual([false, true]);
      await Bun.sleep(50);
      // Convex calls onChange(true) again once the fresh token is confirmed (STUDY-27 §1.6).
      expect(changes).toEqual([true, true]);
      expect(await c.mutation(api.notes.add, {})).toBe("ada");
      expect(c.getAuth()?.decoded.sub).toBe("ada");
      c.client.clearAuth();
      await until(() => sub.getCurrentValue() === null, "signed out");
      expect(c.getAuth()).toBeUndefined();
    });

    test("initialAuthTokenReuse: the accepted cached token is kept (one fetch)", async () => {
      const { c, fetches, fetcher } = await setup({ initialAuthTokenReuse: true });
      const changes: boolean[] = [];
      c.setAuth(fetcher({ sub: "ada" }), (a) => changes.push(a));
      await until(() => changes.length === 1, "confirmed");
      await Bun.sleep(100);
      expect(fetches).toEqual([false]);
    });

    test("a token refused every time: two retries with fresh tokens, then signed out, with Convex's error", async () => {
      const { c, errors, fetches, fetcher } = await setup();
      const sub = c.onUpdate(api.notes.whoami, {}, () => {});
      const changes: boolean[] = [];
      c.setAuth(fetcher({ aud: "other" }), (a) => changes.push(a));
      await until(() => changes.length > 0, "the verdict");
      expect(changes).toEqual([false]);
      expect(fetches).toEqual([false, true, true, true]);
      expect(errors.some((e) => e.startsWith('Failed to authenticate: "No auth provider found'))).toBe(true);
      await until(() => sub.getCurrentValue() === null, "anonymous result");
    });

    test("the fresh token is refetched `leeway` seconds before it expires", async () => {
      const { c, fetches, fetcher } = await setup({ authRefreshTokenLeewaySeconds: 10 });
      const now = () => Math.floor(Date.now() / 1000);
      // 11 s of life and a 10 s leeway: refetched about 1 s after it is confirmed.
      c.setAuth(fetcher(() => ({ iat: now(), exp: now() + 11 })));
      await until(() => fetches.length === 2, "the fresh token");
      await Bun.sleep(400);
      expect(fetches.length).toBe(2);
      await until(() => fetches.length === 3, "the scheduled refetch");
      expect(fetches).toEqual([false, true, true]);
    });

    test("expectAuth: a mutation made before setAuth waits, and runs as the user", async () => {
      const { c, fetcher } = await setup({ expectAuth: true });
      const done = c.mutation(api.notes.add, {});
      await Bun.sleep(100);
      c.setAuth(fetcher({ sub: "ada" }));
      expect(await done).toBe("ada");
    });

    test("a token fetcher with nothing to give: signed out without sending a token", async () => {
      const { c } = await setup();
      const sub = c.onUpdate(api.notes.whoami, {}, () => {});
      const changes: boolean[] = [];
      const fetches: boolean[] = [];
      c.setAuth(
        async ({ forceRefreshToken }) => {
          fetches.push(forceRefreshToken);
          return null;
        },
        (a) => changes.push(a),
      );
      await until(() => changes.length > 0, "the verdict");
      expect(changes).toEqual([false]);
      expect(fetches).toEqual([false, true]);
      await until(() => sub.getCurrentValue() === null, "anonymous result");
    });
    test("a second setAuth during the first one's fetch wins: the first token is never used", async () => {
      const { issuer, c } = await setup();
      const sub = c.onUpdate(api.notes.whoami, {}, () => {});
      c.setAuth(async () => {
        await Bun.sleep(100);
        return issuer.sign({ sub: "old" });
      });
      let n = 0;
      c.setAuth(async () => issuer.sign({ sub: "new", jti: `n${n++}` }));
      await until(() => sub.getCurrentValue() === "new", "the second user");
      await Bun.sleep(200);
      expect(sub.getCurrentValue()).toBe("new");
      expect(c.getAuth()?.decoded.sub).toBe("new");
    });

    test("a refused cached token: onRefreshChange(true), a fresh token, then onRefreshChange(false)", async () => {
      const { issuer, c } = await setup();
      const sub = c.onUpdate(api.notes.whoami, {}, () => {});
      const changes: boolean[] = [];
      const refreshing: boolean[] = [];
      let n = 0;
      c.client.setAuth(
        async ({ forceRefreshToken }) =>
          issuer.sign({ sub: "ada", jti: `r${n++}`, ...(forceRefreshToken ? {} : { aud: "x" }) }),
        (a) => changes.push(a),
        (r) => refreshing.push(r),
      );
      await until(() => sub.getCurrentValue() === "ada", "signed in with the fresh token");
      await until(() => refreshing.length === 2, "refresh done");
      expect(refreshing).toEqual([true, false]);
      expect(changes.every((a) => a)).toBe(true);
    });
  });
