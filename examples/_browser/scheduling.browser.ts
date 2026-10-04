import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../scheduling"));
});
afterAll(() => app?.stop());

test("a self-destructing message counts down live in two tabs, then disappears", async () => {
  const one = await app.open();
  const two = await app.open();
  await one.getByPlaceholder("Write a message…").fill("stays");
  await one.getByRole("button", { name: "Send", exact: true }).click();
  await two.getByText("stays").waitFor();
  await one.getByPlaceholder("Write a message…").fill("boom");
  await one.getByRole("button", { name: "Send, then disappear" }).click();
  await one.getByText("boom (disappears in 5s)").waitFor();
  await two.getByText(/boom \(disappears in [1-4]s\)/).waitFor();
  await one.getByText(/boom/).waitFor({ state: "detached" });
  await two.getByText(/boom/).waitFor({ state: "detached" });
  expect(await one.getByText("stays").isVisible()).toBe(true);
  expect(app.errors).toEqual([]);
});
