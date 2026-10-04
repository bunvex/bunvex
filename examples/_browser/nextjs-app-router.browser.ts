import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../nextjs-app-router"));
});
afterAll(() => app?.stop());

const count = (html: string) => html.match(/Clicked (?:<!-- -->)?(\d+)(?:<!-- -->)? times/)?.[1];

test("the server renders the count, the client keeps it live in two tabs, and the Server Action works", async () => {
  expect(count(await (await fetch(app.url)).text())).toBe("0");
  const one = await app.open();
  const two = await app.open();
  await one.getByText("Clicked 0 times.").waitFor();
  await two.getByText("Clicked 0 times.").waitFor();
  await one.getByRole("button", { name: "Click" }).click();
  await one.getByText("Clicked 1 times.").waitFor();
  await two.getByText("Clicked 1 times.").waitFor();
  expect(count(await (await fetch(app.url)).text())).toBe("1");
  await one.getByRole("link", { name: /Server Component and a Server Action/ }).click();
  await one.getByText("Clicked 1 times.").waitFor();
  await one.getByRole("button", { name: "Click" }).click();
  await one.getByText("Clicked 2 times.").waitFor();
  await two.getByText("Clicked 2 times.").waitFor();
  expect(app.errors).toEqual([]);
});

test("the Server Action works without JavaScript", async () => {
  const context = await app.browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${app.url}/server-only`);
  const before = Number((await page.getByText(/Clicked \d+ times\./).innerText()).match(/\d+/)![0]);
  await page.getByRole("button", { name: "Click" }).click();
  await page.getByText(`Clicked ${before + 1} times.`).waitFor();
  await context.close();
});
