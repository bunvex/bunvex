import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../http"));
});
afterAll(() => app?.stop());

test("a message POSTed over HTTP (as the page's curl does) shows live; the GET routes answer", async () => {
  const page = await app.open();
  const shown = await page.locator("pre, code").first().innerText();
  const author = shown.match(/"author":"(User \d+)"/)?.[1];
  expect(author).toBeDefined();
  const posted = await fetch(`${app.d.siteUrl}/postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author, body: "over http" }),
  });
  expect(posted.status).toBe(200);
  await page.locator("li", { hasText: "over http" }).waitFor();
  const n = author!.replace(/\D/g, "");
  for (const r of [
    await fetch(`${app.d.siteUrl}/getMessagesByAuthor?authorNumber=${n}`),
    await fetch(`${app.d.siteUrl}/getMessagesByAuthor`, { headers: { authorNumber: n } }),
    await fetch(`${app.d.siteUrl}/getAuthorMessages/${n}`),
  ]) {
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain("over http");
  }
  await page.getByPlaceholder(/message/i).fill("from the page");
  await page.getByRole("button", { name: /send/i }).click();
  await page.locator("li", { hasText: "from the page" }).waitFor();
  expect(app.errors).toEqual([]);
});
