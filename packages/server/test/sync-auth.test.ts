// Authentication over the sync protocol (STUDY-27 §1.5): `Authenticate User`, AuthError, TokenExpired, and
// shared executions keyed by identity only when the query read it.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { startIssuer } from "./issuer.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const issuer = await startIssuer({ cacheControl: "max-age=600" });
  stops.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    // Reads the identity only once there is an item: a shared run that turns per-user.
    late: query(async ({ db, auth }) =>
      (await db.query("items").first()) ? ((await auth.getUserIdentity())?.subject ?? null) : "none",
    ),
    add: mutation(async ({ db, auth }) => {
      const me = await auth.getUserIdentity();
      await db.insert("items", { by: me?.subject ?? null });
      return me?.subject ?? null;
    }),
  });
  const { server, sync, stop } = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: false,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
  });
  stops.push(stop);
  return { issuer, sync, url: `ws://127.0.0.1:${server.port}/api/1.0.0/sync` };
}

async function client(url: string) {
  const ws = new WebSocket(url);
  const got: v1.ServerMessage[] = [];
  ws.onmessage = (m) => got.push(v1.parseServerMessage(String(m.data)));
  const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
  await new Promise((r) => (ws.onopen = r));
  const send = (m: v1.ClientMessage) => ws.send(v1.encodeClientMessage(m));
  send({ type: "Connect", sessionId: crypto.randomUUID(), connectionCount: 0, lastCloseReason: null, clientTs: 0 });
  let querySet = 0;
  let identity = 0;
  const until = async <T>(f: () => T | undefined | false) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x) return x;
      await Bun.sleep(5);
    }
    throw new Error(`timed out: ${JSON.stringify(got, (_, x) => (typeof x === "bigint" ? String(x) : x))}`);
  };
  const transitions = () => got.filter((m): m is v1.Transition => m.type === "Transition");
  /** The latest value each query id was given. */
  const values = () => {
    const out: Record<number, unknown> = {};
    for (const t of transitions())
      for (const m of t.modifications) if (m.type === "QueryUpdated") out[m.queryId] = m.value;
    return out;
  };
  return {
    ws,
    got,
    closed,
    until,
    transitions,
    values,
    subscribe: (queryId: number, udfPath: string) =>
      send({
        type: "ModifyQuerySet",
        baseVersion: querySet,
        newVersion: ++querySet,
        modifications: [{ type: "Add", queryId, udfPath, args: [{}] }],
      }),
    authenticate: (token: string | null) =>
      send(
        token === null
          ? { type: "Authenticate", tokenType: "None", baseVersion: identity++ }
          : { type: "Authenticate", tokenType: "User", value: token, baseVersion: identity++ },
      ),
    mutate: (requestId: number, udfPath: string) => send({ type: "Mutation", requestId, udfPath, args: [{}] }),
  };
}

describe("authentication over the sync protocol", () => {
  test("Authenticate User: the identity version advances and the queries re-run as that user", async () => {
    const { issuer, url } = await setup();
    const c = await client(url);
    c.subscribe(1, "m:whoami");
    await c.until(() => c.values()[1] === null);
    c.authenticate(await issuer.sign({ sub: "ada" }));
    const t = await c.until(() => c.transitions().find((x) => x.endVersion.identity === 1));
    expect(t.modifications).toContainEqual(expect.objectContaining({ type: "QueryUpdated", queryId: 1, value: "ada" }));
    // A mutation sent right after Authenticate runs as the new user (messages are handled in order).
    c.authenticate(await issuer.sign({ sub: "bob" }));
    c.mutate(0, "m:add");
    const r = (await c.until(() => c.got.find((m) => m.type === "MutationResponse"))) as v1.MutationResponse;
    expect(r.success && r.result).toBe("bob");
    c.authenticate(null);
    await c.until(() => c.transitions().some((x) => x.endVersion.identity === 3) && c.values()[1] === null);
  });

  test("two users on one query that reads the identity each see their own; an identity-free query is shared", async () => {
    const { issuer, sync, url } = await setup();
    const ada = await client(url);
    const bob = await client(url);
    ada.authenticate(await issuer.sign({ sub: "ada" }));
    bob.authenticate(await issuer.sign({ sub: "bob" }));
    for (const c of [ada, bob]) c.subscribe(1, "m:whoami");
    await ada.until(() => ada.values()[1] === "ada");
    await bob.until(() => bob.values()[1] === "bob");
    const before = sync.stats.executions;
    for (const c of [ada, bob]) c.subscribe(2, "m:count");
    await ada.until(() => ada.values()[2] === 0);
    await bob.until(() => bob.values()[2] === 0);
    // Ada's run read no identity: it is stored shared, and Bob reuses it (or joins it) instead of running again.
    expect(sync.stats.executions - before).toBeLessThanOrEqual(2);
    const shared = sync.stats.executions;
    ada.mutate(0, "m:add");
    await ada.until(() => ada.values()[2] === 1);
    await bob.until(() => bob.values()[2] === 1);
    expect(sync.stats.executions - shared).toBe(1); // one run of m:count at the new ts, for both users
    expect(ada.values()[1]).toBe("ada");
    expect(bob.values()[1]).toBe("bob");
  });

  test("a query stored shared whose next run reads the identity: each caller still gets their own", async () => {
    const { issuer, url } = await setup();
    const ada = await client(url);
    const bob = await client(url);
    ada.authenticate(await issuer.sign({ sub: "ada" }));
    bob.authenticate(await issuer.sign({ sub: "bob" }));
    for (const c of [ada, bob]) c.subscribe(1, "m:late");
    await ada.until(() => ada.values()[1] === "none");
    await bob.until(() => bob.values()[1] === "none");
    ada.mutate(0, "m:add");
    await ada.until(() => ada.values()[1] === "ada");
    await bob.until(() => bob.values()[1] === "bob");
  });

  test("a token that fails verification: AuthError (update attempted), then close", async () => {
    const { issuer, url } = await setup();
    const c = await client(url);
    c.authenticate(await issuer.sign({ aud: "other" }));
    await c.closed;
    expect(c.got.find((m) => m.type === "AuthError")).toMatchObject({
      type: "AuthError",
      baseVersion: 0,
      authUpdateAttempted: true,
    });
    expect((c.got.find((m) => m.type === "AuthError") as v1.AuthError).error).toContain("No auth provider found");
  });

  test("an identity whose token has expired: AuthError TokenExpired (no update attempted), then close", async () => {
    const { issuer, url } = await setup();
    const c = await client(url);
    // `exp` is in whole seconds: round up so the token lives 1–2 s whatever the current millisecond.
    const exp = Math.ceil(Date.now() / 1000) + 1;
    c.authenticate(await issuer.sign({ sub: "ada", exp }));
    c.subscribe(1, "m:whoami");
    await c.until(() => c.values()[1] === "ada");
    await Bun.sleep(exp * 1000 - Date.now() + 10);
    c.mutate(0, "m:add");
    await c.closed;
    expect(c.got.find((m) => m.type === "AuthError")).toMatchObject({
      error: "Token identity expired",
      baseVersion: 1,
      authUpdateAttempted: false,
    });
  });
});
