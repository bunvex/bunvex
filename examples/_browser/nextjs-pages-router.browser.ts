import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../nextjs-pages-router"));
});
afterAll(() => app?.stop());

test("the counter is live in two tabs, and the API route reads it from the server", async () => {
  const one = await app.open();
  const two = await app.open();
  await one.getByText("Clicks: 0").waitFor();
  await two.getByText("Clicks: 0").waitFor();
  await one.getByRole("button", { name: "Add one" }).click();
  await one.getByText("Clicks: 1").waitFor();
  await two.getByText("Clicks: 1").waitFor();
  expect(await (await fetch(`${app.url}/api/clicks`)).json()).toEqual({ clicks: 1 });
  expect(app.errors).toEqual([]);
});
