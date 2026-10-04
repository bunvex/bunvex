import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../typescript"));
});
afterAll(() => app?.stop());

test("a typed message shows live in a second tab, with its time", async () => {
  const one = await app.open();
  const two = await app.open();
  await one.getByPlaceholder("Write a message…").fill("typed hello");
  await one.getByRole("button", { name: "Send" }).click();
  await two.getByText("typed hello").waitFor();
  expect(await one.locator("li").first().innerText()).toMatch(/\d{1,2}:\d{2}/);
  expect(app.errors).toEqual([]);
});
