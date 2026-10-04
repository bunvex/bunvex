import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../cron-jobs"));
});
afterAll(() => app?.stop());

test("the cron clears the chat, and the page follows", async () => {
  const page = await app.open();
  await page.getByPlaceholder("Write a message…").fill("soon gone");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("soon gone").waitFor();
  // The cron runs every 10 seconds.
  await page.getByText("soon gone").waitFor({ state: "detached", timeout: 25_000 });
  expect(app.errors).toEqual([]);
});
