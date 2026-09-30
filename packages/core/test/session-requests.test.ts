// `_session_requests`: a session mutation commits at most once per (sessionId, requestId) (STUDY-23 §4.3).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

test("two concurrent runs of one request: one commits, the other replays its outcome", async () => {
  const e = await new Engine(
    defineSchema({ t: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const run = (tag: string) =>
    e.sessionMutation(
      async (db) => {
        await gate; // both attempts read "no record" before either commits
        await db.insert("t", { tag });
        return tag;
      },
      "m:x",
      { sessionId: "s", requestId: 1 },
      (value) => ({ result: JSON.stringify(value), logLines: [`ran ${value}`] }),
    );
  const both = Promise.all([run("a"), run("b")]);
  await Bun.sleep(5);
  open();
  const [ra, rb] = await both;
  const committed = [ra, rb].filter((r) => "value" in r);
  const replayed = [ra, rb].filter((r) => "replayed" in r);
  expect(committed).toHaveLength(1);
  expect(replayed).toHaveLength(1);
  const winner = (committed[0] as { value: string }).value;
  expect((replayed[0] as { replayed: unknown }).replayed).toEqual({
    result: JSON.stringify(winner),
    logLines: [`ran ${winner}`],
  });
  expect(await e.query((db) => db.query("t").collect())).toHaveLength(1);
  // The replay's ts is at or after the commit's.
  expect(replayed[0].ts >= committed[0].ts).toBe(true);
});
