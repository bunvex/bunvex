import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { Subscriptions } from "../src/subscriptions.ts";

async function setup() {
  const e = await new Engine(
    defineSchema({ flags: defineTable(v.any()).index("by_name", ["name"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const log: string[] = [];
  const subs = new Subscriptions(e, (_k, m) => log.push("value" in m ? m.value : `error: ${m.error}`));
  return { e, subs, log };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

// Throws until the flag exists; afterwards returns its value.
const flagQuery = (db: any) =>
  db
    .query("flags")
    .withIndex("by_name", (q: any) => q.eq("name", "f"))
    .first()
    .then((d: any) => {
      if (!d) throw new Error("no flag yet");
      if (d.v === "boom") throw new Error("bad flag");
      return d.v;
    });

describe("subscriptions and errors (STUDY-08 D1/D2)", () => {
  test("a subscription whose first run throws re-runs when what it read changes", async () => {
    const { e, subs, log } = await setup();
    await subs.subscribe("k", flagQuery);
    expect(log).toEqual(["error: no flag yet"]);
    await e.mutation((db) => db.insert("flags", { name: "f", v: "on" }));
    await settle();
    expect(log).toEqual(["error: no flag yet", '"on"']);
  });

  test("a value that comes back after an error is published again", async () => {
    const { e, subs, log } = await setup();
    const id = await e.mutation((db) => db.insert("flags", { name: "f", v: "on" }));
    await subs.subscribe("k", flagQuery);
    await e.mutation((db) => db.patch("flags", id, { v: "boom" }));
    await settle();
    await e.mutation((db) => db.patch("flags", id, { v: "on" }));
    await settle();
    expect(log).toEqual(['"on"', "error: bad flag", '"on"']);
    // An unchanged result is not re-sent.
    await e.mutation((db) => db.patch("flags", id, { other: 1 }));
    await settle();
    expect(log).toHaveLength(3);
  });

  test("a late subscriber to a failing key gets the error", async () => {
    const { subs } = await setup();
    await subs.subscribe("k", flagQuery);
    expect(await subs.subscribe("k", flagQuery)).toEqual({ error: "no flag yet" });
  });
});
