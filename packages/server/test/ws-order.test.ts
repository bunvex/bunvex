// One connection's mutations run one at a time, in the order they were sent, as in Convex's sync worker
// (STUDY-22); different connections still run concurrently.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation } from "../src/functions.ts";
import { createServer, MAX_PENDING_MUTATIONS } from "../src/server.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** m:step records its start and end; while `gates[name]` is pending, the step waits on it. */
async function setup() {
  const events: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    step: mutation(async ({ db }, { name }: { name: string }) => {
      events.push(`start ${name}`);
      await gates.get(name);
      await db.insert("items", { name });
      events.push(`end ${name}`);
      return name;
    }),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
    const frames: { t: string; id: number; v?: unknown }[] = [];
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
    await new Promise((r) => (ws.onopen = r));
    const mut = (id: number, name: string) => ws.send(JSON.stringify({ t: "mut", id, path: "m:step", args: { name } }));
    return { ws, frames, closed, mut };
  };
  const gate = (name: string) => {
    let open!: () => void;
    gates.set(name, new Promise<void>((r) => (open = r)));
    return open;
  };
  return { events, connect, gate, engine };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5);
  expect(cond()).toBe(true);
};

test("a connection's mutations run one at a time, in order", async () => {
  const { events, connect, gate } = await setup();
  const openA = gate("a");
  const c = await connect();
  c.mut(1, "a");
  c.mut(2, "b");
  c.mut(3, "c");
  await until(() => events.length >= 1);
  await Bun.sleep(30); // b and c must not start while a is still running
  expect(events).toEqual(["start a"]);
  openA();
  await until(() => c.frames.length === 3);
  expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  expect(c.frames.map((f) => f.id)).toEqual([1, 2, 3]);
  c.ws.close();
});

test("different connections are not serialised against each other", async () => {
  const { events, connect, gate } = await setup();
  const openA = gate("a");
  const one = await connect();
  const two = await connect();
  one.mut(1, "a");
  await until(() => events.includes("start a"));
  two.mut(1, "b");
  await until(() => two.frames.length === 1); // b finishes while a is still blocked
  expect(events).toEqual(["start a", "start b", "end b"]);
  openA();
  await until(() => one.frames.length === 1);
  one.ws.close();
  two.ws.close();
});

test("a failing mutation does not stall the queue", async () => {
  const { connect } = await setup();
  const c = await connect();
  c.ws.send(JSON.stringify({ t: "mut", id: 1, path: "m:missing", args: {} }));
  c.mut(2, "x");
  await until(() => c.frames.length === 2);
  expect(c.frames.map((f) => f.id)).toEqual([1, 2]);
  expect(c.frames[1].v).toBe("x");
  c.ws.close();
});

test(`pending mutation number ${MAX_PENDING_MUTATIONS + 1} closes the connection with 1013`, async () => {
  const { connect, gate, events } = await setup();
  const openA = gate("a");
  const c = await connect();
  for (let i = 0; i < MAX_PENDING_MUTATIONS; i++) c.mut(i, i === 0 ? "a" : `n${i}`);
  await until(() => events.includes("start a"));
  c.mut(MAX_PENDING_MUTATIONS, "overflow");
  const e = await c.closed;
  expect(e.code).toBe(1013);
  expect(e.reason).toBe("TooManyConcurrentMutations");
  openA();
  await Bun.sleep(20);
  // Only the mutation already running when the connection closed finished; the queued ones never started.
  expect(events).toEqual(["start a", "end a"]);
});
