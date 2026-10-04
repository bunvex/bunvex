import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, imageWidth, PNG, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../system-tables"));
});
afterAll(() => app?.stop());

test("scheduled sends go pending → success (or canceled), and an uploaded file's row and image show", async () => {
  const page = await app.open();
  const body = page.getByPlaceholder("Write a message…");
  const delay = page.locator('input[type="number"]');
  await body.fill("now");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("now").waitFor();
  await delay.fill("2");
  await body.fill("later");
  await page.getByRole("button", { name: "Send" }).click();
  await page
    .getByText(/: pending/)
    .first()
    .waitFor();
  await page.locator("li", { hasText: "later" }).first().waitFor();
  await page
    .getByText(/: success/)
    .first()
    .waitFor();
  await delay.fill("60");
  await body.fill("never");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByText(/: canceled/).waitFor();
  await page.locator('input[type="file"]').setInputFiles(PNG);
  await page.locator("li img").first().waitFor();
  expect(await imageWidth(page, "li img")).toBe(1);
  await page.getByText(/image\/png, \d+ bytes/).waitFor();
  expect(app.errors).toEqual([]);
});
