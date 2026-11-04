// A cap on one connection's query set (AD-50, STUDY-207): a `ModifyQuerySet` that would leave the connection past
// `BUNVEX_MAX_QUERIES_PER_CONNECTION` (default 4096, 0 for none) closes it with `BadRequest`, before any of the
// frame is applied. The count is the set the frame would leave: what the session holds, the modifications still
// pending, then the frame's.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, v1Client as client, updated } from "./v1-client.ts";

const stops: (() => void)[] = [];
/** Opened by a test: `m:held` waits on it, so a transition stays running and later frames stay pending. */
let open: () => void = () => {};
let gate = Promise.resolve();
/** Called when `m:held` starts. */
let onHeld: () => void = () => {};
afterEach(() => {
  for (const s of stops.splice(0)) s();
  delete process.env.BUNVEX_MAX_QUERIES_PER_CONNECTION;
});

/** A server whose cap comes from the environment, as an operator sets it (unset: the default). */
async function setup(cap?: string) {
  if (cap !== undefined) process.env.BUNVEX_MAX_QUERIES_PER_CONNECTION = cap;
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    n: query((_ctx, { n }: { n: number }) => n),
    held: query(async () => {
      onHeld();
      await gate;
      return "held";
    }),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  return `ws://127.0.0.1:${server!.port}/api/1.0.0/sync`;
}

const adds = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => add(from + i, "m:n", { n: from + i }));
const refusal = (held: number, cap: number) => ({
  type: "FatalError" as const,
  error: `Too many queries on this connection: ${held}, past BUNVEX_MAX_QUERIES_PER_CONNECTION (${cap})`,
});

describe("the query set cap", () => {
  test("by default 4096: one frame past it is refused before any of its queries runs", async () => {
    const c = await client(await setup());
    c.modify(adds(0, 4097));
    await c.closed;
    expect(c.got).toContainEqual(refusal(4097, 4096));
    expect(c.transitions()).toEqual([]);
  });

  test("at the cap a frame is accepted; one more query is refused, counting the queries already held", async () => {
    const c = await client(await setup("3"));
    c.modify(adds(0, 3));
    expect(updated(await c.transition(0))).toEqual({ 0: 0, 1: 1, 2: 2 });
    c.modify(adds(3, 1));
    await c.closed;
    expect(c.got).toContainEqual(refusal(4, 3));
  });

  test("only the set a frame leaves counts: removing and adding as many is accepted at the cap", async () => {
    const c = await client(await setup("3"));
    c.modify(adds(0, 3));
    await c.transition(0);
    c.modify([{ type: "Remove", queryId: 0 }, { type: "Remove", queryId: 1 }, ...adds(10, 2)]);
    expect(updated(await c.transition(1))).toEqual({ 10: 10, 11: 11 });
    // A removed id added back counts once, and removing it again frees its place.
    c.modify([
      add(0, "m:n", { n: 0 }),
      { type: "Remove", queryId: 0 },
      { type: "Remove", queryId: 2 },
      add(20, "m:n", { n: 20 }),
    ]);
    expect(updated(await c.transition(2))).toEqual({ 20: 20 });
    expect(c.got.some((m) => m.type === "FatalError")).toBe(false);
  });

  test("frames not applied yet count: they wait while a transition runs, and the next frame counts them", async () => {
    gate = new Promise<void>((r) => (open = r));
    const held = new Promise<void>((r) => (onHeld = r));
    const c = await client(await setup("3"));
    c.modify([add(0, "m:held")]);
    // The transition runs `m:held`, which waits: these two frames queue behind it, unapplied.
    await held;
    c.modify(adds(1, 2));
    c.modify(adds(3, 1));
    await c.closed;
    open();
    // 1 held + 2 pending + 1 = 4.
    expect(c.got).toContainEqual(refusal(4, 3));
  });

  test("0 turns it off, as Convex has no cap", async () => {
    const c = await client(await setup("0"));
    c.modify(adds(0, 5));
    expect(Object.keys(updated(await c.transition(0)))).toHaveLength(5);
  });
});
