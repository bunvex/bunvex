import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../custom-errors"));
});
afterAll(() => app?.stop());

test("a mutation's error and a query's error show in the page; clearing recovers", async () => {
  const page = await app.open();
  const box = page.getByPlaceholder("At most 50 characters");
  await box.fill("x".repeat(60));
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("A message is at most 50 characters.").waitFor();
  // Past 20 messages, the list query throws a BunvexError with data: the page's error boundary shows it.
  for (let i = 0; i < 21; i++)
    await app.d.http.mutation("messages:send" as never, { body: `m${i}`, author: "bot" } as never);
  await page.getByText("Too many messages! (21)").waitFor();
  await page.getByRole("button", { name: "Clear the messages" }).click();
  await box.fill("back");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("back").waitFor();
  // The demo's two errors: the client logs a refused call, and React a caught render error. Nothing else.
  const demo = ["A message is at most 50 characters.", "Too many messages!"];
  expect(app.errors.filter((e) => !demo.some((d) => e.includes(d)))).toEqual([]);
});
