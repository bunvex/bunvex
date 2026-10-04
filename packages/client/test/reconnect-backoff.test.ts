// The reconnect backoff resets only once the client has really resynced, not when a socket opens (STUDY-65
// G-C23). Convex's `web_socket_manager.ts` resets `retries` only when `onMessage` reports
// `hasSyncedPastLastReconnect`, which `client.ts` computes from `local_state.ts` (every query re-sent on the
// reconnect answered, and the re-sent Authenticate confirmed) and `request_manager.ts` (no request older than
// the reconnect left). Its `client_node.test.ts` pins three cases: an idle client, a mutation in flight, and an
// authenticated client. These tests drive the real client against a real WebSocket server the test controls,
// plus a flapping server that accepts the socket and then drops it, which must back off further each time.
import { afterEach, expect, test } from "bun:test";
import { v1 } from "@bunvex/protocol";
import type { Value } from "@bunvex/values";
import { BaseBunvexClient } from "../src/base-client.ts";
import { instantiateNoopLogger } from "../src/logging.ts";

type Conn = { ws: Bun.ServerWebSocket<unknown>; querySet: number; identity: number; ts: bigint; clock: bigint };

/** A sync server the test drives. It remembers what each connection asked for, to answer with the right versions. */
function fakeServer() {
  const received: { conn: number; message: v1.ClientMessage }[] = [];
  const conns: Conn[] = [];
  let waiters: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ ws, querySet: 0, identity: 0, ts: 0n, clock: 0n });
      },
      message(ws, data) {
        const conn = conns.findIndex((c) => c.ws === ws);
        received.push({ conn, message: v1.parseClientMessage(String(data)) });
        for (const w of waiters.splice(0)) w();
      },
    },
  });
  const current = () => conns.at(-1)!;
  /** Wait for the next message of `type` on the latest connection, after `from` (an index into `received`). */
  async function next<T extends v1.ClientMessage["type"]>(type: T, from = 0) {
    for (;;) {
      const i = received.findIndex((r, j) => j >= from && r.conn === conns.length - 1 && r.message.type === type);
      if (i !== -1) {
        cursor = i + 1;
        return received[i]!.message as Extract<v1.ClientMessage, { type: T }>;
      }
      await new Promise<void>((r) => waiters.push(r));
    }
  }
  let cursor = 0;
  return {
    address: `http://localhost:${server.port}`,
    connections: () => conns.length,
    /** The next message of `type`, after the last one taken. */
    next: <T extends v1.ClientMessage["type"]>(type: T) => next(type, cursor),
    /**
     * A transition on the latest connection: to the latest query set the client sent, and one identity further
     * when `authenticated`.
     */
    transition(modifications: v1.StateModification[], opts: { querySet?: number; authenticated?: boolean } = {}) {
      const c = current();
      const start = { querySet: c.querySet, identity: c.identity, ts: c.ts };
      c.clock += 100n;
      c.ts = c.clock;
      c.querySet = opts.querySet ?? c.querySet;
      if (opts.authenticated) c.identity += 1;
      const end = { querySet: c.querySet, identity: c.identity, ts: c.ts };
      c.ws.send(v1.encodeServerMessage({ type: "Transition", startVersion: start, endVersion: end, modifications }));
    },
    mutationResponse(requestId: number) {
      const c = current();
      c.clock += 100n;
      c.ws.send(
        v1.encodeServerMessage({
          type: "MutationResponse",
          requestId,
          success: true,
          result: null,
          ts: c.clock,
          logLines: [],
        }),
      );
    },
    /** Drop the latest connection, as a server that fails would. */
    drop() {
      current().ws.close(1011, "InternalServerError");
    },
    stop() {
      for (const w of waiters.splice(0)) w();
      waiters = [];
      server.stop(true);
    },
  };
}

const updated = (queryId: number, value: Value): v1.StateModification => ({
  type: "QueryUpdated",
  queryId,
  value: value as v1.JSONValue,
  logLines: [],
  journal: null,
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup() {
  const server = fakeServer();
  // Short backoffs: the tests count retries, they do not measure the waits.
  const client = new BaseBunvexClient(server.address, () => {}, {
    unsavedChangesWarning: false,
    logger: instantiateNoopLogger({ verbose: false }),
    webSocket: { defaultInitialBackoffMs: 5, maxBackoffMs: 40 },
  });
  cleanups.push(() => server.stop());
  cleanups.push(() => client.close());
  return { server, client, retries: () => client.connectionState().connectionRetries };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(4);
  expect(cond()).toBe(true);
};

test("an idle client: an empty transition after the reconnect does not reset the backoff; the re-sent query's answer does", async () => {
  const { server, client, retries } = setup();
  client.subscribe("m:q", {});
  await server.next("Connect");
  await server.next("ModifyQuerySet");
  server.transition([updated(0, "first")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "first");
  expect(retries()).toBe(0);

  server.drop();
  await server.next("Connect");
  await server.next("ModifyQuerySet");
  expect(retries()).toBe(1);

  // The server took the query set but has not answered the query yet.
  server.transition([], { querySet: 1 });
  await Bun.sleep(30);
  expect(retries()).toBe(1);

  server.transition([updated(0, "again")]);
  await waitFor(() => client.localQueryResult("m:q", {}) === "again");
  expect(retries()).toBe(0);
});

test("a mutation in flight across the reconnect holds the backoff until it is answered and reflected", async () => {
  const { server, client, retries } = setup();
  client.subscribe("m:q", {});
  await server.next("Connect");
  await server.next("ModifyQuerySet");
  server.transition([updated(0, "first")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "first");

  const done = client.mutation("m:write", {});
  const { requestId } = await server.next("Mutation");
  server.drop();
  await server.next("Connect");
  await server.next("ModifyQuerySet");
  // The client re-sends the unanswered mutation.
  expect((await server.next("Mutation")).requestId).toBe(requestId);
  expect(retries()).toBe(1);

  // The queries are answered, the mutation is not.
  server.transition([updated(0, "second")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "second");
  expect(retries()).toBe(1);

  // Answered, but not yet reflected in a transition: still in flight.
  server.mutationResponse(requestId);
  await Bun.sleep(30);
  expect(retries()).toBe(1);

  server.transition([]);
  await done;
  expect(retries()).toBe(0);
});

test("an authenticated client: the backoff resets once the re-sent token is confirmed and the query answered", async () => {
  const { server, client, retries } = setup();
  // Not a JWT, so no refresh is scheduled: the only Authenticate messages are the ones the test expects. A new
  // token each fetch, so the fresh one after the cached one is sent.
  let fetched = 0;
  client.setAuth(
    async () => `opaque-token-${++fetched}`,
    () => {},
  );
  await server.next("Connect");
  // The cached token, then (after the server confirms it) a fresh one, as Convex.
  await server.next("Authenticate");
  server.transition([], { authenticated: true });
  await server.next("Authenticate");
  server.transition([], { authenticated: true });

  client.subscribe("m:q", {});
  await server.next("ModifyQuerySet");
  server.transition([updated(0, "first")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "first");
  expect(retries()).toBe(0);

  server.drop();
  await server.next("Connect");
  await server.next("Authenticate");
  await server.next("ModifyQuerySet");
  expect(retries()).toBe(1);

  // The query answered first: the token is still unconfirmed.
  server.transition([updated(0, "second")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "second");
  expect(retries()).toBe(1);

  server.transition([], { authenticated: true });
  await waitFor(() => retries() === 0);
  // And it stays reset: the next drop is one retry again, not two.
  server.drop();
  await server.next("Connect");
  expect(retries()).toBe(1);
});

test("a flapping server that accepts the socket and drops it before answering backs off further each time", async () => {
  const { server, client, retries } = setup();
  client.subscribe("m:q", {});
  await server.next("Connect");
  await server.next("ModifyQuerySet");
  server.transition([updated(0, "first")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "first");

  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    server.drop();
    await server.next("Connect");
    await server.next("ModifyQuerySet");
    seen.push(retries());
  }
  // Each open is a new attempt, not a healthy connection: the count (and with it the backoff) keeps growing.
  expect(seen).toEqual([1, 2, 3, 4, 5]);
  expect(server.connections()).toBe(6);

  // Once a connection answers everything, it resets.
  server.transition([updated(0, "back")], { querySet: 1 });
  await waitFor(() => client.localQueryResult("m:q", {}) === "back");
  expect(retries()).toBe(0);
});
