// Guarantees first checked on protocol v0, now on v1 (STUDY-23 P2): results re-evaluated after errors
// (STUDY-08 D1/D2, B8), one query held twice (B14), a connection's mutations in order (STUDY-22), errors with
// data and lines (STUDY-20), and an exhausted OCC budget ending the connection (STUDY-21 D2).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

const REQUEST_ID = /^\[Request ID: [0-9a-f]{16}\] /;

async function setup(occ?: { initialMs: number; maxMs: number }) {
  const engine = await new Engine(
    defineSchema({ flags: defineTable(v.any()).index("by_name", ["name"]), items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    occ ? { occInitialBackoffMs: occ.initialMs, occMaxBackoffMs: occ.maxMs } : {},
  ).init();
  const events: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const functions = new Functions(engine).register("m", {
    // Throws until the flag exists; afterwards returns its value (or throws for "boom").
    flag: query(async ({ db }) => {
      const d = await db
        .query("flags")
        .withIndex("by_name", (q) => q.eq("name", "f"))
        .first();
      if (!d) throw new Error("no flag yet");
      if (d.v === "boom") throw new Error("bad flag");
      return d.v as string;
    }),
    setFlag: mutation(async ({ db }, { value }: { value: string }) => {
      const d = await db
        .query("flags")
        .withIndex("by_name", (q) => q.eq("name", "f"))
        .first();
      if (d) await db.patch("flags", d._id, { v: value });
      else await db.insert("flags", { name: "f", v: value });
    }),
    touchFlag: mutation(async ({ db }) => {
      const d = await db.query("flags").first();
      if (d) await db.patch("flags", d._id, { other: Math.random() });
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    step: mutation(async ({ db }, { name }: { name: string }) => {
      events.push(`start ${name}`);
      await gates.get(name);
      await db.insert("items", { name });
      events.push(`end ${name}`);
      return name;
    }),
    fail: mutation(() => {
      console.log("x");
      throw new BunvexError({ code: 7 });
    }),
    ok: mutation(() => {
      console.log("y");
      return 5;
    }),
    failingQuery: query(() => {
      throw new BunvexError({ code: 8 });
    }),
  });
  const { server, sync, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const gate = (name: string) => {
    let open!: () => void;
    gates.set(
      name,
      new Promise<void>((r) => {
        open = r;
      }),
    );
    return open;
  };
  return { engine, functions, sync, events, gate, url: syncUrl(server.port) };
}

describe("results are re-evaluated after errors (STUDY-08 D1/D2)", () => {
  test("a query whose first run throws runs again when what it read changes", async () => {
    const { url } = await setup();
    const c = await v1Client(url);
    const w = await v1Client(url);
    c.modify([add(1, "m:flag")]);
    await c.transition(0);
    w.mutate(0, "m:setFlag", { value: "on" });
    await c.until(() => history(c.transitions(), 1).length === 2);
    expect(history(c.transitions(), 1).map((x) => String(x).replace(REQUEST_ID, ""))).toEqual([
      expect.stringContaining("error: "),
      "on",
    ]);
    expect(String(history(c.transitions(), 1)[0])).toContain("no flag yet");
  });

  test("a value that comes back after an error is sent again; an unchanged one is not", async () => {
    const { url } = await setup();
    const w = await v1Client(url);
    w.mutate(0, "m:setFlag", { value: "on" });
    await w.until(() => w.responses().length === 1);
    const c = await v1Client(url);
    c.modify([add(1, "m:flag")]);
    await c.transition(0);
    for (const [i, value] of [
      [1, "boom"],
      [2, "on"],
    ] as const) {
      w.mutate(i, "m:setFlag", { value });
      await c.until(() => history(c.transitions(), 1).length === i + 1);
    }
    const h = history(c.transitions(), 1);
    expect(h[0]).toBe("on");
    expect(String(h[1])).toContain("bad flag");
    expect(h[2]).toBe("on");
    w.mutate(3, "m:touchFlag");
    await w.until(() => w.responses().length === 4);
    await Bun.sleep(30);
    expect(history(c.transitions(), 1)).toHaveLength(3);
  });

  test("a late subscriber to a failing query gets the error", async () => {
    const { url } = await setup();
    const a = await v1Client(url);
    a.modify([add(1, "m:flag")]);
    await a.transition(0);
    const b = await v1Client(url);
    b.modify([add(7, "m:flag")]);
    const t = await b.transition(0);
    expect(t.modifications[0]).toMatchObject({ type: "QueryFailed", queryId: 7 });
  });
});

test("one connection holding the same query twice keeps the other when one is removed (B14)", async () => {
  const { url } = await setup();
  const c = await v1Client(url);
  c.modify([add(1, "m:count"), add(2, "m:count")]);
  await c.transition(0);
  c.modify([{ type: "Remove", queryId: 1 }]);
  await c.transition(1);
  c.mutate(0, "m:ok");
  const w = await v1Client(url);
  w.mutate(0, "m:step", { name: "x" });
  await c.until(() => history(c.transitions(), 2).includes(1));
  expect(history(c.transitions(), 1)).toEqual([0]);
});

describe("a connection's mutations run one at a time, in order (STUDY-22)", () => {
  test("in arrival order, each after the previous one finished", async () => {
    const { events, gate, url } = await setup();
    const openA = gate("a");
    const c = await v1Client(url);
    for (const [i, name] of ["a", "b", "c"].entries()) c.mutate(i, "m:step", { name });
    await c.until(() => events.length >= 1);
    await Bun.sleep(30); // b and c must not start while a is running
    expect(events).toEqual(["start a"]);
    openA();
    await c.until(() => c.responses().length === 3);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(c.responses().map((r) => r.requestId)).toEqual([0, 1, 2]);
  });

  test("different connections are not serialized against each other", async () => {
    const { events, gate, url } = await setup();
    const openA = gate("a");
    const one = await v1Client(url);
    const two = await v1Client(url);
    one.mutate(0, "m:step", { name: "a" });
    await one.until(() => events.includes("start a"));
    two.mutate(0, "m:step", { name: "b" });
    await two.until(() => two.responses().length === 1); // b finishes while a is still held
    expect(events).toEqual(["start a", "start b", "end b"]);
    openA();
    await one.until(() => one.responses().length === 1);
  });

  test("a failing mutation does not stall the queue", async () => {
    const { url } = await setup();
    const c = await v1Client(url);
    c.mutate(0, "m:missing");
    c.mutate(1, "m:step", { name: "x" });
    await c.until(() => c.responses().length === 2);
    const [r0, r1] = c.responses();
    expect(r0.success).toBe(false);
    expect(r1).toMatchObject({ requestId: 1, success: true, result: "x" });
  });
});

test("mutation responses carry the error's data and the lines; a failed query carries its data (STUDY-20)", async () => {
  const { url } = await setup();
  const c = await v1Client(url);
  c.mutate(1, "m:fail");
  c.mutate(2, "m:ok");
  c.modify([add(1, "m:failingQuery")]);
  await c.until(() => c.responses().length === 2 && c.transitions().some((t) => t.modifications.length > 0));
  const [fail, ok] = c.responses();
  if (fail.success || !ok.success) throw new Error("unexpected results");
  expect(fail.result).toMatch(REQUEST_ID);
  expect(fail.result).toContain("Uncaught BunvexError:");
  expect(fail.errorData).toEqual({ code: 7 });
  expect(fail.logLines).toEqual(["[LOG] 'x'"]);
  expect(ok).toMatchObject({ result: 5, logLines: ["[LOG] 'y'"] });
  const failed = c
    .transitions()
    .flatMap((t) => t.modifications)
    .find((m) => m.type === "QueryFailed");
  expect(failed).toMatchObject({ errorData: { code: 8 } });
  expect((failed as { errorMessage: string }).errorMessage).toMatch(REQUEST_ID);
});

test("a mutation that exhausts its OCC budget closes the connection with 1013 and the code (STUDY-21 D2)", async () => {
  const { engine, functions, url } = await setup({ initialMs: 1, maxMs: 2 });
  const id = await engine.mutation((db) => db.insert("items", { n: 0 }));
  // Every execution of m:bump reads the item, then a rival commit overwrites it before m:bump commits.
  let rival: Promise<unknown> = Promise.resolve();
  functions.register("m", {
    bump: mutation(async ({ db }) => {
      await db.get("items", id as never);
      rival = engine.mutation((d) => d.patch("items", id, { n: Math.random() }), "m:other");
      await rival;
      await db.patch("items", id as never, { n: -1 });
    }),
  });
  const c = await v1Client(url);
  c.mutate(1, "m:bump");
  const e = await c.closed;
  expect(e.code).toBe(1013);
  expect(e.reason).toBe("OptimisticConcurrencyControlFailure");
});
