import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../tutorial"));
});
afterAll(() => app?.stop());

test("two tabs chat live; a reload keeps the history; the list keeps the 50 most recent", async () => {
  const one = await app.open();
  const two = await app.open();
  await one.getByPlaceholder("Write a message…").fill("hi from one");
  await one.getByRole("button", { name: "Send" }).click();
  await two.getByText("hi from one").waitFor();
  await two.getByPlaceholder("Write a message…").fill("hi from two");
  await two.getByRole("button", { name: "Send" }).click();
  await one.getByText("hi from two").waitFor();
  expect(await one.getByPlaceholder("Write a message…").inputValue()).toBe("");
  await one.reload();
  await one.getByText("hi from two").waitFor();
  for (let i = 0; i < 55; i++)
    await app.d.http.mutation("messages:send" as never, { body: `m${i}`, author: "bot" } as never);
  await one.getByText("bot: m54").waitFor();
  expect(await one.locator("li").count()).toBe(50);
  expect(app.errors).toEqual([]);
});
