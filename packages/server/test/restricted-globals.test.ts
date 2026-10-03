// fetch, timers and randomness in functions, as Convex's isolate (STUDY-66 §4): a timer in a query or mutation
// fails it even when caught, at its next database call or when it ends; actions keep the real globals.
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";

const NO_TIMER = "Can't use setTimeout in queries and mutations. Please consider using an action.";

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const steps: string[] = [];
  const fns = new Functions(engine).register("m", {
    // The timer is caught; the next read throws its error, and catching that does not help either.
    timerThenRead: query(async ({ db }) => {
      try {
        setTimeout(() => steps.push("callback"), 0);
      } catch {}
      steps.push("after setTimeout");
      try {
        await db.query("items").first();
        steps.push("read");
      } catch (e) {
        steps.push(`read threw: ${(e as Error).message}`);
      }
      return "finished";
    }),
    timerThenWrite: mutation(async ({ db }) => {
      setTimeout(() => {}, 0);
      await db.insert("items", { n: 1 }).catch(() => {});
      return "finished";
    }),
    uuid: mutation(() => crypto.randomUUID()),
    inAction: action(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return [
        crypto.randomUUID().length,
        (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"])).type,
      ];
    }),
  });
  return { engine, fns, steps };
}

describe("restricted globals in functions", () => {
  test("a caught setTimeout still fails the query, from its next read on", async () => {
    const { fns, steps } = await setup();
    await expect(fns.runQuery("m:timerThenRead", {})).rejects.toThrow(NO_TIMER);
    expect(steps).toEqual(["after setTimeout", `read threw: ${NO_TIMER}`]);
  });

  test("a mutation with a timer fails and writes nothing", async () => {
    const { fns, engine } = await setup();
    await expect(fns.runMutation("m:timerThenWrite", {})).rejects.toThrow(NO_TIMER);
    expect(await engine.query((db) => db.query("items").collect())).toEqual([]);
  });

  test("randomUUID works in a mutation; actions keep the real timers and crypto", async () => {
    const { fns } = await setup();
    expect(await fns.runMutation("m:uuid", {})).toMatch(/^[0-9a-f-]{36}$/);
    expect(await fns.runAction("m:inAction", {})).toEqual([36, "secret"]);
  });
});
