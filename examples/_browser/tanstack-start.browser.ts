import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../tanstack-start"));
});
afterAll(() => app?.stop());

test("the page arrives rendered with the messages, then stays live in two tabs", async () => {
  await app.d.http.mutation("messages:send" as never, { body: "before the page", author: "Ada" } as never);
  // Rendered on the server: the message is in the document before any script runs.
  const html = await (await fetch(app.url)).text();
  expect(html.replaceAll("<!-- -->", "")).toContain("<li>Ada: before the page</li>");

  const one = await app.open();
  const two = await app.open();
  await one.getByText("Ada: before the page").waitFor();
  // Hydrated once the browser picked the user's name (typing earlier would be reset by hydration).
  for (const page of [one, two]) await page.getByText(/^User \d+$/).waitFor();
  await one.getByPlaceholder("Write a message…").fill("hi from one");
  await one.getByRole("button", { name: "Send" }).click();
  await two.getByText("hi from one").waitFor();
  // A write from elsewhere reaches the hydrated page through its subscription.
  await app.d.http.mutation("messages:send" as never, { body: "from the server", author: "bot" } as never);
  await one.getByText("bot: from the server").waitFor();
  await two.getByText("bot: from the server").waitFor();
  expect(app.errors).toEqual([]);
});
