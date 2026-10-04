import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, eventually, items, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../search"));
});
afterAll(() => app?.stop());

test("results by relevance, a new match joining live, no match, and all again when cleared", async () => {
  const page = await app.open();
  for (const body of ["the quick brown fox", "lazy dogs sleep", "a fox and a dog", "nothing here", "Fox fox FOX"]) {
    await page.getByPlaceholder("Write a message…").fill(body);
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText(body).waitFor();
  }
  const search = page.getByPlaceholder("Search messages…");
  await search.fill("fox");
  await eventually(async () => (await items(page)).length === 3, "3 results for fox");
  expect((await items(page))[0]).toContain("Fox fox FOX");
  await page.getByPlaceholder("Write a message…").fill("another fox appears");
  await page.getByRole("button", { name: "Send" }).click();
  await eventually(async () => (await items(page)).length === 4, "the new match, live");
  await search.fill("zebra");
  await eventually(async () => (await items(page)).length === 0, "no results");
  await search.fill("");
  await eventually(async () => (await items(page)).length === 6, "every message");
  expect(app.errors).toEqual([]);
});
