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

test("arguments the validators refuse: the page shows why, nothing is written, the text stays", async () => {
  const page = await app.open();
  await page.getByText("1 messages").waitFor();
  for (const [mistake, says] of [
    ["no body", "Object is missing the required field `body`"],
    ["a number as the body", "Value does not match validator"],
    ["tags as a string", "Value does not match validator"],
    ["an extra field", "Object contains extra field `extra` that is not in the validator"],
  ]) {
    await page.getByPlaceholder("Message").fill("refused");
    await page.locator("select").selectOption(mistake!);
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("alert").getByText(`ArgumentValidationError: ${says}`, { exact: false }).waitFor();
    expect(await page.getByPlaceholder("Message").inputValue()).toBe("refused");
    await page.locator("select").selectOption("none");
  }
  await page.getByText("1 messages").waitFor();
  // The client logs each refused call (as Convex's does); nothing else may be logged.
  expect(app.errors.filter((e) => !e.includes("ArgumentValidationError"))).toEqual([]);
});
