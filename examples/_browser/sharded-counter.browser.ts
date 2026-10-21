import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../sharded-counter"));
});
afterAll(() => app?.stop());

test("checking boxes in one tab counts them in the other, live", async () => {
  const one = await app.open();
  const two = await app.open();
  await one.getByText("0 boxes checked").waitFor();
  await two.getByText("0 boxes checked").waitFor();
  const first = one.locator('[id="0-0"] input');
  await first.waitFor();
  await first.click();
  await one.locator('[id="1-0"] input').click();
  await two.getByText("2 boxes checked").waitFor();
  await two.locator('[id="0-0"] input:checked').waitFor();
  await two.locator('[id="0-0"] input').click();
  await one.getByText("1 boxes checked").waitFor();
  expect(await one.locator('[id="0-0"] input').isChecked()).toBe(false);
  expect(app.errors).toEqual([]);
});
