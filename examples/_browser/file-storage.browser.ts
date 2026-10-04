import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, imageWidth, PNG, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../file-storage"));
});
afterAll(() => app?.stop());

test("a text and an uploaded image show up, the image loads, and a second tab sees both live", async () => {
  const one = await app.open();
  const two = await app.open();
  await one.getByPlaceholder("Write a message…").fill("hello text");
  await one.getByRole("button", { name: "Send", exact: true }).click();
  await one.getByText("hello text").waitFor();
  await one.locator('input[type="file"]').setInputFiles(PNG);
  await one.getByRole("button", { name: "Send image" }).click();
  await one.locator("li img").first().waitFor();
  expect(await imageWidth(one, "li img")).toBe(1);
  await two.locator("li img").first().waitFor();
  expect(await imageWidth(two, "li img")).toBe(1);
  await two.getByPlaceholder("Write a message…").fill("from tab 2");
  await two.getByRole("button", { name: "Send", exact: true }).click();
  await one.getByText("from tab 2").waitFor();
  expect(app.errors).toEqual([]);
});
