import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, eventually, items, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../pagination"));
});
afterAll(() => app?.stop());

test("five at first, Load more to the end, and a new message on top live", async () => {
  const one = await app.open();
  await one.getByRole("button", { name: "Add 20 messages" }).click();
  // A first page made on an empty board grows while it is the last one (README): reload for five.
  await eventually(async () => (await items(one)).length === 20, "the 20 messages");
  await one.reload();
  await eventually(async () => (await items(one)).length === 5, "the first page of 5");
  for (const n of [10, 15, 20]) {
    await one.getByRole("button", { name: "Load more" }).click();
    await eventually(async () => (await items(one)).length === n, `${n} messages`);
  }
  await one.getByRole("button", { name: "Load more" }).click();
  await one.getByRole("button", { name: "No more messages" }).waitFor();
  expect(await one.getByRole("button", { name: "No more messages" }).isDisabled()).toBe(true);
  const two = await app.open();
  await two.getByPlaceholder("Write a message…").fill("newest");
  await two.getByRole("button", { name: "Send" }).click();
  await eventually(async () => (await items(one))[0]?.includes("newest"), "the new message on top");
  expect(app.errors).toEqual([]);
});
