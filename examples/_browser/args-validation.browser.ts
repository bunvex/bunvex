import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../args-validation"));
});
afterAll(() => app?.stop());

test("a message with tags shows them, and the count follows", async () => {
  const page = await app.open();
  await page.getByText("0 messages").waitFor();
  await page.getByPlaceholder("Message").fill("with tags");
  await page.getByPlaceholder("tags, comma separated").fill("a, b ,c");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("#a #b #c").waitFor();
  await page.getByText("1 messages").waitFor();
  expect(app.errors).toEqual([]);
});
