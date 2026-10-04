import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../prewarming"));
});
afterAll(() => app?.stop());

/** Record whether "Loading…" ever shows from now on. */
const watchLoading = () => {
  const w = window as unknown as { sawLoading: boolean };
  w.sawLoading = false;
  new MutationObserver(() => {
    if (document.body.innerText.includes("Loading…")) w.sawLoading = true;
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
};
const sawLoading = () => (window as unknown as { sawLoading: boolean }).sawLoading;

test("after hovering (prewarmed), the chat opens with its data at once", async () => {
  await app.d.http.mutation("messages:send" as never, { body: "hello", author: "Ada" } as never);
  const page = await app.open();
  await page.evaluate(watchLoading);
  await page.getByRole("button", { name: /Open the chat/ }).hover();
  await page.getByText("Open the chat (prewarmed)").waitFor();
  // The prewarmed result is local once the subscription has its first result.
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /Open the chat/ }).click();
  await page.getByText("hello").waitFor();
  expect(await page.evaluate(sawLoading)).toBe(false);
  expect(app.errors).toEqual([]);
});
