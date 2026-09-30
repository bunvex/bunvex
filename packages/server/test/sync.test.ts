// The sync protocol v1 (STUDY-23): per-connection state versions, transitions at one ts, shared executions.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { BunvexError, v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { canonicalizeUdfPath } from "../src/sync.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()), b: defineTable(v.any()), other: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    count: query(async ({ db }, { table }: { table: "a" | "b" }) => (await db.query(table).collect()).length),
    both: mutation(async ({ db }) => {
      await db.insert("a", {});
      await db.insert("b", {});
    }),
    insert: mutation(({ db }, { table }: { table: string }) => db.insert(table, {})),
    fails: query(() => {
      throw new BunvexError({ code: 7 });
    }),
    page: query(({ db }, { paginationOpts }: { paginationOpts: { numItems: number; cursor: string | null } }) =>
      db.query("a").paginate(paginationOpts),
    ),
    logs: query(() => {
      console.log("hello");
      return 1;
    }),
    default: query(() => "the default export"),
    ping: action(() => "pong"),
  });
  const { server, sync, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  return { engine, sync, url: `ws://127.0.0.1:${server!.port}/api/1.0.0/sync` };
}

/** A bare v1 client: sends messages, records what the server sends. */
async function client(url: string) {
  const ws = new WebSocket(url);
  const got: v1.ServerMessage[] = [];
  ws.onmessage = (m) => got.push(v1.parseServerMessage(String(m.data)));
  const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
  await new Promise((r) => (ws.onopen = r));
  const send = (m: v1.ClientMessage) => ws.send(v1.encodeClientMessage(m));
  send({ type: "Connect", sessionId: crypto.randomUUID(), connectionCount: 0, lastCloseReason: null, clientTs: 0 });
  let querySet = 0;
  const modify = (modifications: (v1.AddQuery | v1.RemoveQuery)[]) =>
    send({ type: "ModifyQuerySet", baseVersion: querySet, newVersion: ++querySet, modifications });
  const transitions = () => got.filter((m): m is v1.Transition => m.type === "Transition");
  const until = async <T>(f: () => T | undefined) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x) return x;
      await Bun.sleep(5);
    }
    throw new Error(`timed out; got ${JSON.stringify(got, (_, x) => (typeof x === "bigint" ? `${x}n` : x))}`);
  };
  /** The next transition after the first `n` ones. */
  const transition = (n: number) => until(() => transitions()[n]);
  return { ws, got, closed, send, modify, transitions, transition, until };
}

const add = (queryId: number, udfPath: string, args: Record<string, unknown> = {}): v1.AddQuery => ({
  type: "Add",
  queryId,
  udfPath,
  args: [args as v1.JSONValue],
});
const updated = (t: v1.Transition) =>
  Object.fromEntries(
    t.modifications.flatMap((m) => (m.type === "QueryUpdated" ? [[m.queryId, m.value]] : [])),
  ) as Record<number, unknown>;

describe("sync protocol v1", () => {
  test("adding queries: one transition from the initial version with every result", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:count", { table: "a" }), add(2, "m:count", { table: "b" })]);
    const t = await c.transition(0);
    expect(t.startVersion).toEqual({ querySet: 0, ts: 0n, identity: 0 });
    expect(t.endVersion.querySet).toBe(1);
    expect(t.endVersion.identity).toBe(0);
    expect(updated(t)).toEqual({ 1: 0, 2: 0 });
  });

  test("a mutation that changes two queries: ONE transition carries both, at a ts ≥ the mutation's", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:count", { table: "a" }), add(2, "m:count", { table: "b" })]);
    await c.transition(0);
    c.send({ type: "Mutation", requestId: 0, udfPath: "m:both", args: [{}] });
    const r = (await c.until(() => c.got.find((m) => m.type === "MutationResponse"))) as v1.MutationResponse;
    expect(r.success).toBe(true);
    const t = await c.until(() => c.transitions().find((x) => x.modifications.length > 0 && x !== c.transitions()[0]));
    expect(updated(t)).toEqual({ 1: 1, 2: 1 });
    expect(r.success && t.endVersion.ts >= r.ts).toBe(true);
    // No transition ever shows one of them updated without the other.
    for (const x of c.transitions()) expect(Object.keys(updated(x)).length % 2).toBe(0);
  });

  test("versions are gapless: each transition starts where the previous one ended", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:count", { table: "a" })]);
    for (let i = 0; i < 5; i++) c.send({ type: "Mutation", requestId: i, udfPath: "m:insert", args: [{ table: "a" }] });
    c.modify([add(2, "m:count", { table: "b" })]);
    await c.until(() => c.transitions().some((t) => updated(t)[1] === 5));
    const ts = c.transitions();
    for (let i = 1; i < ts.length; i++) expect(ts[i].startVersion).toEqual(ts[i - 1].endVersion);
    for (let i = 1; i < ts.length; i++) expect(ts[i].endVersion.ts >= ts[i - 1].endVersion.ts).toBe(true);
  });

  test("a mutation that changes nothing watched still advances the ts; unchanged results are not resent", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:count", { table: "a" })]);
    const first = await c.transition(0);
    c.send({ type: "Mutation", requestId: 0, udfPath: "m:insert", args: [{ table: "other" }] });
    const r = (await c.until(() => c.got.find((m) => m.type === "MutationResponse"))) as v1.MutationResponse;
    const t = await c.until(() => c.transitions().find((x) => r.success && x.endVersion.ts >= r.ts));
    expect(t.endVersion.ts > first.endVersion.ts).toBe(true);
    expect(t.modifications).toEqual([]);
  });

  test("removing a query: QueryRemoved", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:count", { table: "a" })]);
    await c.transition(0);
    c.modify([{ type: "Remove", queryId: 1 }]);
    const t = await c.transition(1);
    expect(t.modifications).toEqual([{ type: "QueryRemoved", queryId: 1 }]);
    expect(t.endVersion.querySet).toBe(2);
  });

  test("a base version that does not match: FatalError, then the connection closes", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.send({ type: "ModifyQuerySet", baseVersion: 3, newVersion: 4, modifications: [] });
    await c.closed;
    expect(c.got).toContainEqual({
      type: "FatalError",
      error: "Base version 3 passed up doesn't match the current version 0",
    });
  });

  test("a malformed message: FatalError, then close", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.ws.send(JSON.stringify({ type: "Nope" }));
    await c.closed;
    expect(c.got[0]).toEqual({ type: "FatalError", error: 'Invalid message: unknown type "Nope"' });
  });

  test("a client that observed a later ts than the server's: the connection ends with an internal error", async () => {
    const { url } = await setup();
    const ws = new WebSocket(url);
    const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
    await new Promise((r) => (ws.onopen = r));
    ws.send(
      v1.encodeClientMessage({
        type: "Connect",
        sessionId: crypto.randomUUID(),
        connectionCount: 1,
        lastCloseReason: null,
        maxObservedTimestamp: 1_000_000n,
        clientTs: 0,
      }),
    );
    expect((await closed).code).toBe(1011);
  });

  test("a failing query: QueryFailed with the error's data", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:fails")]);
    const t = await c.transition(0);
    const m = t.modifications[0] as Extract<v1.StateModification, { type: "QueryFailed" }>;
    expect(m.type).toBe("QueryFailed");
    expect(m.errorMessage).toContain("Uncaught BunvexError");
    expect(m.errorData).toEqual({ code: 7 });
  });

  test("log lines travel with the result", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:logs")]);
    const t = await c.transition(0);
    expect(t.modifications[0]).toMatchObject({ type: "QueryUpdated", value: 1 });
    expect((t.modifications[0] as { logLines: string[] }).logLines).toHaveLength(1);
  });

  test("a paginated query gets a journal, and its page keeps its end when rows are added", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.send({ type: "Mutation", requestId: 0, udfPath: "m:insert", args: [{ table: "a" }] });
    await c.until(() => c.got.find((m) => m.type === "MutationResponse"));
    c.modify([add(1, "m:page", { paginationOpts: { numItems: 5, cursor: null } })]);
    const t = await c.until(() => c.transitions().find((x) => x.modifications.length > 0));
    const m = t.modifications[0] as Extract<v1.StateModification, { type: "QueryUpdated" }>;
    expect(typeof m.journal).toBe("string");
    expect((m.value as { page: unknown[]; isDone: boolean }).isDone).toBe(true);
    // Another connection writes: only the commit's notification can tell this one's query to re-run.
    const n = c.transitions().length;
    const writer = await client(url);
    writer.send({ type: "Mutation", requestId: 1, udfPath: "m:insert", args: [{ table: "a" }] });
    const next = await c.until(() =>
      c
        .transitions()
        .slice(n)
        .find((x) => x.modifications.length > 0),
    );
    // The page ends where it ended: it now holds the new row too (the end cursor was `end`, isDone).
    expect((updated(next)[1] as { page: unknown[] }).page).toHaveLength(2);
  });

  test("connections share one execution per query and ts", async () => {
    const { url, sync } = await setup();
    const cs = await Promise.all([client(url), client(url), client(url)]);
    // Let every Connect land, then subscribe all three at once.
    await Bun.sleep(20);
    const before = sync.stats.executions;
    for (const c of cs) c.modify([add(1, "m:count", { table: "a" })]);
    await Promise.all(cs.map((c) => c.transition(0)));
    expect(sync.stats.executions - before).toBe(1);
    cs[0].send({ type: "Mutation", requestId: 0, udfPath: "m:insert", args: [{ table: "a" }] });
    await Promise.all(cs.map((c) => c.until(() => c.transitions().some((t) => updated(t)[1] === 1))));
    expect(sync.stats.executions - before).toBe(2);
  });

  test("a burst of commits from another connection: the reader converges on the final result", async () => {
    const { url } = await setup();
    const reader = await client(url);
    const writer = await client(url);
    reader.modify([add(1, "m:count", { table: "a" })]);
    await reader.transition(0);
    for (let i = 0; i < 50; i++)
      writer.send({ type: "Mutation", requestId: i, udfPath: "m:insert", args: [{ table: "a" }] });
    await reader.until(() => reader.transitions().some((t) => updated(t)[1] === 50));
    // Coalesced: fewer transitions than commits, and the count only grows.
    const counts = reader.transitions().flatMap((t) => (1 in updated(t) ? [updated(t)[1] as number] : []));
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  test("udf paths are canonical: `.js` stripped, `default` when no export is named", async () => {
    expect(canonicalizeUdfPath("m.js:count")).toBe("m:count");
    expect(canonicalizeUdfPath("dir/m")).toBe("dir/m:default");
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m.js")]);
    expect(updated(await c.transition(0))).toEqual({ 1: "the default export" });
  });

  test("actions answer with ActionResponse; unsupported tokens get an AuthError", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.send({ type: "Action", requestId: 9, udfPath: "m:ping", args: [{}] });
    expect(await c.until(() => c.got.find((m) => m.type === "ActionResponse"))).toMatchObject({
      requestId: 9,
      success: true,
      result: "pong",
    });
    c.send({ type: "Authenticate", tokenType: "User", value: "jwt", baseVersion: 0 });
    await c.closed;
    expect(c.got.find((m) => m.type === "AuthError")).toMatchObject({ baseVersion: 0, authUpdateAttempted: true });
  });

  test("Authenticate None advances the identity version", async () => {
    const { url } = await setup();
    const c = await client(url);
    c.modify([add(1, "m:count", { table: "a" })]);
    await c.transition(0);
    c.send({ type: "Authenticate", tokenType: "None", baseVersion: 0 });
    const t = await c.transition(1);
    expect(t.endVersion.identity).toBe(1);
    expect(t.modifications).toEqual([]); // re-run, same result: not resent
  });
});
