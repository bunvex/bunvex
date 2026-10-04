import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../relational-data-modeling"));
});
afterAll(() => app?.stop());

test("each channel shows its own messages, live in another tab", async () => {
  const one = await app.open();
  for (const c of ["general", "random"]) {
    await one.getByPlaceholder("New channel").fill(c);
    await one.getByRole("button", { name: "Add" }).click();
    await one.getByRole("button", { name: `#${c}` }).waitFor();
  }
  await one.getByRole("button", { name: "#general" }).click();
  await one.getByPlaceholder("Write a message…").fill("in general");
  await one.getByRole("button", { name: "Send" }).click();
  await one.getByText("in general").waitFor();
  await one.getByRole("button", { name: "#random" }).click();
  const two = await app.open();
  await two.getByRole("button", { name: "#random" }).click();
  await two.getByPlaceholder("Write a message…").fill("from tab 2 in random");
  await two.getByRole("button", { name: "Send" }).click();
  await one.getByText("from tab 2 in random").waitFor();
  expect(await one.getByText("in general").count()).toBe(0);
  expect(app.errors).toEqual([]);
});
