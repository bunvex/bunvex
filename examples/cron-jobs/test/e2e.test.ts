// The cron-jobs example end to end (STUDY-90): crons.ts clears the messages every 10 seconds, and a subscriber
// sees the list empty itself with nobody calling anything.
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

test("the cron clears the messages on its own, and subscribers see it", async () => {
  let latest: unknown[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (messages) => {
    latest = messages;
  });
  await d.http.mutation(api.messages.send, { body: "soon gone", author: "Ada" });
  await until(() => latest?.length === 1, "the message");
  // The interval is 10 s (`until` waits up to 10 s a call): allow two of them.
  await until(() => latest?.length === 0, "the cron's clear").catch(() =>
    until(() => latest?.length === 0, "the cron's clear"),
  );
}, 30_000);

test("clearAll is internal: a client cannot call it", async () => {
  await expect(d.http.mutation(api.messages.clearAll as never, {})).rejects.toThrow(/Could not find public function/);
});

test("the front end typechecks and builds", () => build(DIR));
