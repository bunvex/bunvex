// The client's auth races (STUDY-65 G-C2–G-C7), differential: each scenario drives the official base client (the
// oracle) and BaseBunvexClient against a sync server the test scripts message by message, and both must send
// the same messages and report the same auth changes. The scenarios are the ones Convex's
// `react/auth_websocket.test.tsx` describes (that suite is skipped upstream, as flaky; here the server is
// scripted, so nothing races but what the scenario sets up):
// - a cached token the fetcher cannot give, then a fresh one (G-C2);
// - an AuthError for the first token arriving after a second setAuth (G-C3);
// - an AuthError not about a token update while a fresh token awaits confirmation (G-C4);
// - a scheduled refetch starting during a reauthentication (G-C5);
// - a fresh token refused once, then accepted (G-C6);
// - Authenticate sent before a query added while the token was fetched (G-C7).
import { afterEach, describe, expect, test } from "bun:test";
import { BaseBunvexClient } from "@bunvex/client";
import { v1 } from "@bunvex/protocol";
import { BaseConvexClient } from "convex/browser";

type Fetcher = (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;
type AnyBaseClient = {
  mutation(name: string, args?: Record<string, unknown>): Promise<unknown>;
  setAuth(fetchToken: Fetcher, onChange: (isAuthenticated: boolean) => void): void;
  subscribe(name: string, args?: Record<string, unknown>): { unsubscribe(): void };
  close(): Promise<void>;
};

const quiet = { logVerbose() {}, log() {}, warn() {}, error() {} };
const clients: [string, (address: string) => AnyBaseClient][] = [
  [
    "official client",
    (address) =>
      new BaseConvexClient(address, () => {}, {
        unsavedChangesWarning: false,
        authRefreshTokenLeewaySeconds: 2,
        logger: quiet,
      }) as unknown as AnyBaseClient,
  ],
  [
    "BaseBunvexClient",
    (address) =>
      new BaseBunvexClient(address, () => {}, {
        unsavedChangesWarning: false,
        authRefreshTokenLeewaySeconds: 2,
        logger: quiet,
      }) as unknown as AnyBaseClient,
  ],
];

/** What the server saw, in order: a message's type, plus the base version and token of an Authenticate. */
type Seen = { type: string; baseVersion?: number; token?: string };

/** A sync server the scenario drives: it records each message and answers only when told to. */
function scriptedServer() {
  const seen: Seen[] = [];
  let read = 0;
  let down = false;
  let wake: (() => void) | null = null;
  const conns: { ws: Bun.ServerWebSocket<unknown>; identity: number; ts: bigint }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (down) return new Response("down", { status: 503 });
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ ws, identity: 0, ts: 0n });
      },
      message(_ws, data) {
        const m = JSON.parse(String(data)) as { type: string; baseVersion?: number; value?: string };
        // The official client may report events of its own; the protocol messages are what is compared.
        if (m.type === "Event") return;
        seen.push(
          m.type === "Authenticate" ? { type: m.type, baseVersion: m.baseVersion, token: m.value } : { type: m.type },
        );
        wake?.();
      },
    },
  });
  const current = () => conns.at(-1)!;
  return {
    address: `http://127.0.0.1:${server.port}`,
    /** The next message the client sent (any connection), as Convex's tests `receive()`. */
    async receive(): Promise<Seen> {
      for (let waited = 0; read >= seen.length; waited++) {
        if (waited > 200) throw new Error(`no message after ${JSON.stringify(seen)}`);
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
      return seen[read++]!;
    },
    /** The server accepts the pending Authenticate: the identity goes one up. */
    confirmAuth() {
      const c = current();
      const start = { querySet: 0, identity: c.identity, ts: c.ts };
      c.identity += 1;
      c.ts += 1n;
      c.ws.send(
        v1.encodeServerMessage({
          type: "Transition",
          startVersion: start,
          endVersion: { querySet: 0, identity: c.identity, ts: c.ts },
          modifications: [],
        }),
      );
    },
    /** An AuthError, then the close that always follows it. */
    authError(baseVersion: number, authUpdateAttempted: boolean) {
      const c = current();
      c.ws.send(v1.encodeServerMessage({ type: "AuthError", error: "bla", baseVersion, authUpdateAttempted }));
      c.ws.close(1000);
    },
    /** Drop the connection and refuse new ones until `up()`. */
    down() {
      down = true;
      current().ws.close(1011, "InternalServerError");
    },
    up() {
      down = false;
    },
    stop: () => server.stop(true),
  };
}

const now = () => Math.floor(Date.now() / 1000);
/** A JWT the clients can decode (they read `iat` and `exp` to schedule refreshes); the signature is not checked. */
const jwt = (name: string, iat = now(), exp = now() + 3600) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: name, iat, exp })).toString("base64url"),
    Buffer.from(name).toString("base64url"),
  ].join(".");

const auth = (baseVersion: number, token: string): Seen => ({ type: "Authenticate", baseVersion, token });
const connect: Seen = { type: "Connect" };
const querySet: Seen = { type: "ModifyQuerySet" };

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

for (const [name, make] of clients)
  describe(`auth races: ${name}`, () => {
    function setup() {
      const server = scriptedServer();
      const client = make(server.address);
      cleanup.push(server.stop);
      cleanup.push(() => client.close());
      const changes: boolean[] = [];
      const fetches: boolean[] = [];
      /** A fetcher handing out `tokens` in order (null when they run out). */
      const fetcher =
        (tokens: (string | null | ((force: boolean) => string | null))[], delayMs = 0): Fetcher =>
        async ({ forceRefreshToken }) => {
          fetches.push(forceRefreshToken);
          if (delayMs && forceRefreshToken) await Bun.sleep(delayMs);
          const t = tokens.shift() ?? null;
          return typeof t === "function" ? t(forceRefreshToken) : t;
        };
      const settle = () => Bun.sleep(100);
      return { server, client, changes, fetches, fetcher, settle };
    }
    /** The next messages are exactly these. */
    const expectNext = async (server: ReturnType<typeof scriptedServer>, ...messages: Seen[]) => {
      for (const m of messages) expect(await server.receive()).toEqual(m);
    };

    test("no cached token: a fresh one is fetched and sent, then confirmed (G-C2)", async () => {
      const { server, client, changes, fetches, fetcher, settle } = setup();
      const fresh = jwt("fresh");
      client.setAuth(fetcher([(force) => (force ? fresh : null), (force) => (force ? fresh : null)]), (a) =>
        changes.push(a),
      );
      // The token comes after two fetches: whether the socket opened before it is timing (both clients agree on
      // what follows), so the two messages after Connect are compared as a set.
      await expectNext(server, connect);
      const next = [await server.receive(), await server.receive()];
      expect(next).toContainEqual(auth(0, fresh));
      expect(next).toContainEqual(querySet);
      server.confirmAuth();
      await settle();
      expect(changes).toEqual([true]);
      expect(fetches).toEqual([false, true]);
    });

    test("an AuthError for the first token after a second setAuth: the second token is used, the first config never hears (G-C3)", async () => {
      const { server, client, fetcher, settle } = setup();
      const bad = jwt("bad");
      const good = jwt("good");
      const first: boolean[] = [];
      const second: boolean[] = [];
      client.setAuth(fetcher([bad, bad, bad]), (a) => first.push(a));
      await expectNext(server, connect, auth(0, bad), querySet);
      let n = 0;
      client.setAuth(
        async () => (n++ === 0 ? good : jwt(`good${n}`)),
        (a) => second.push(a),
      );
      await expectNext(server, auth(1, good));
      server.authError(0, true);
      await expectNext(server, connect, auth(0, good), querySet);
      server.confirmAuth();
      await settle();
      expect(first).toEqual([]);
      expect(second[0]).toBe(true);
      expect(second.every((a) => a)).toBe(true);
    });

    test("an AuthError not about the token update, while the fresh token awaits confirmation: the fresh token is sent again (G-C4)", async () => {
      const { server, client, changes, fetches, fetcher, settle } = setup();
      const initial = jwt("initial");
      const fresh = jwt("fresh");
      client.setAuth(fetcher([initial, fresh]), (a) => changes.push(a));
      await expectNext(server, connect, auth(0, initial), querySet);
      server.confirmAuth();
      await expectNext(server, auth(1, fresh));
      server.authError(1, false);
      await expectNext(server, connect, auth(0, fresh), querySet);
      server.confirmAuth();
      await settle();
      expect(changes).toEqual([true, true]);
      expect(fetches).toEqual([false, true]);
    });

    test("a fresh token refused once is fetched again and confirmed (G-C6)", async () => {
      const { server, client, changes, fetches, fetcher, settle } = setup();
      const [t1, t2, t3] = [jwt("t1"), jwt("t2"), jwt("t3")];
      client.setAuth(fetcher([t1, t2, t3]), (a) => changes.push(a));
      await expectNext(server, connect, auth(0, t1), querySet);
      server.confirmAuth();
      await expectNext(server, auth(1, t2));
      server.authError(1, true);
      await expectNext(server, connect, auth(0, t3), querySet);
      server.confirmAuth();
      await settle();
      expect(fetches).toEqual([false, true, true]);
      expect(changes).toEqual([true, true]);
    });

    test("Authenticate goes before a query added while the new token was fetched (G-C7)", async () => {
      const { server, client, settle } = setup();
      const t1 = jwt("t1");
      client.setAuth(
        async () => t1,
        () => {},
      );
      await expectNext(server, connect, auth(0, t1), querySet);
      server.confirmAuth();
      // The fresh fetch returns the same token: nothing more is sent.
      await settle();
      const t2 = jwt("t2");
      client.setAuth(
        async () => t2,
        () => {},
      );
      client.subscribe("m:q", {});
      await expectNext(server, auth(1, t2), querySet);
    });

    test("a second setAuth while the first token is still being fetched (socket paused): only the second token is sent", async () => {
      const { server, client, settle } = setup();
      const first: boolean[] = [];
      const second: boolean[] = [];
      client.setAuth(
        async () => {
          await Bun.sleep(300);
          return jwt("first");
        },
        (a) => first.push(a),
      );
      const t2 = jwt("second");
      const t2fresh = jwt("second, fresh");
      let n = 0;
      client.setAuth(
        async () => (n++ === 0 ? t2 : t2fresh),
        (a) => second.push(a),
      );
      await expectNext(server, connect, auth(0, t2), querySet);
      server.confirmAuth();
      await expectNext(server, auth(1, t2fresh));
      await Bun.sleep(400); // past the first fetch
      await settle();
      expect(first).toEqual([]);
      expect(second[0]).toBe(true);
      // Nothing more: the first token is never sent.
      expect(await Promise.race([server.receive(), Bun.sleep(200).then(() => "nothing")])).toBe("nothing");
    });

    test("a token rejected with a mutation in flight: the mutation is sent again after the new token", async () => {
      const { server, client, changes, fetcher, settle } = setup();
      const [t1, t2, t3] = [jwt("t1"), jwt("t2"), jwt("t3")];
      client.setAuth(fetcher([t1, t2, t3]), (a) => changes.push(a));
      await expectNext(server, connect, auth(0, t1), querySet);
      server.confirmAuth();
      await expectNext(server, auth(1, t2));
      server.confirmAuth();
      await settle();
      void client.mutation("m:write", {}).catch(() => {});
      await expectNext(server, { type: "Mutation" });
      // The token expired under it: the server refuses it and closes.
      server.authError(2, false);
      await expectNext(server, connect, auth(0, t3), querySet, { type: "Mutation" });
      server.confirmAuth();
      await settle();
      expect(changes.every((a) => a)).toBe(true);
    });

    test("a scheduled refetch while the server is down: the reconnect sends the newest token", async () => {
      const { server, client, fetches, fetcher, settle } = setup();
      // The fresh token lives 3 s with a 2 s leeway: refetched 1 s after it is confirmed, while the server is down.
      const t = now();
      const initial = jwt("initial", t, t + 3600);
      const fresh = jwt("fresh", t, t + 3);
      const refreshed = jwt("refreshed", t + 1, t + 3601);
      client.setAuth(fetcher([initial, fresh, refreshed]), () => {});
      await expectNext(server, connect, auth(0, initial), querySet);
      server.confirmAuth();
      await expectNext(server, auth(1, fresh));
      server.confirmAuth();
      server.down();
      for (let i = 0; i < 100 && fetches.length < 3; i++) await Bun.sleep(50);
      expect(fetches).toEqual([false, true, true]);
      server.up();
      await expectNext(server, connect, auth(0, refreshed), querySet);
      await settle();
    }, 20_000);

    test("a scheduled refetch starting during a reauthentication still restarts the socket (G-C5)", async () => {
      const { server, client, changes, fetches, fetcher, settle } = setup();
      // Forced fetches take 1 s. The fresh token lives 3 s with a 2 s leeway: its refetch is scheduled 1 s after
      // it is confirmed. An AuthError half a second later starts a reauthentication, whose fetch ends after the
      // scheduled one began: that one's token wins, and its fetch must restart the stopped socket.
      const t = now();
      const initial = jwt("initial", t - 10, t + 10);
      const fresh = jwt("fresh", t + 1, t + 4);
      const reauth = jwt("reauth", t + 2, t + 5);
      const scheduled = jwt("scheduled", t + 3, t + 6);
      client.setAuth(fetcher([initial, fresh, reauth, scheduled], 1000), (a) => changes.push(a));
      await expectNext(server, connect, auth(0, initial), querySet);
      server.confirmAuth();
      await expectNext(server, auth(1, fresh));
      server.confirmAuth();
      await Bun.sleep(500);
      server.authError(2, false);
      await expectNext(server, connect, auth(0, scheduled), querySet);
      server.confirmAuth();
      await settle();
      expect(fetches).toEqual([false, true, true, true]);
      expect(changes.every((a) => a)).toBe(true);
    }, 15_000);
  });
