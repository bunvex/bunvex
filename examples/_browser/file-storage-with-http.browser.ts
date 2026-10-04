import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, imageWidth, PNG, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../file-storage-with-http"));
  // The README's setup: the page's origin may call the HTTP actions.
  await app.envSet("CLIENT_ORIGIN", app.url);
});
afterAll(() => app?.stop());

test("an image POSTed to the HTTP action from the page (CORS) is stored, served back, and loads", async () => {
  const page = await app.open();
  await page.getByPlaceholder("Write a message…").fill("text msg");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("text msg").waitFor();
  await page.locator('input[type="file"]').setInputFiles(PNG);
  await page.getByRole("button", { name: "Send image" }).click();
  await page.locator("li img").first().waitFor();
  expect(await imageWidth(page, "li img")).toBe(1);
  expect(app.errors).toEqual([]);
});
