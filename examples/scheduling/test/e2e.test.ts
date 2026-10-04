// The scheduling example end to end (STUDY-90): a message counts down and deletes itself through scheduled
// runs, and a subscriber sees every step live.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("an expiring message counts down, then deletes itself, live", async () => {
  const bodies = new Set<string>();
  let latest: { body: string }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (messages) => {
    latest = messages;
    for (const m of messages) bodies.add(m.body);
  });
  await until(() => latest !== undefined, "the first result");
  await d.http.mutation(api.messages.send, { body: "I stay", author: "Ada" });
  await d.http.mutation(api.messages.sendExpiring, { body: "bye", author: "Ada", seconds: 3, tickMs: 100 });
  await until(() => latest?.length === 2, "both messages");
  // Gone after its countdown; the other one stays.
  await until(() => latest?.length === 1 && latest[0]?.body === "I stay", "the expiring message deleted");
  expect([...bodies].filter((b) => b.startsWith("bye"))).toEqual([
    "bye (disappears in 3s)",
    "bye (disappears in 2s)",
    "bye (disappears in 1s)",
  ]);
});

test("tick is internal: a client cannot call it", async () => {
  await expect(
    d.http.mutation(api.messages.tick as never, { messageId: "x", body: "", secondsLeft: 0, tickMs: 0 }),
  ).rejects.toThrow(/Could not find public function/);
});

test("the front end typechecks and builds", () => build(DIR));
