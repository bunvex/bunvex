import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../react-query"));
});
afterAll(() => app?.stop());

test("live through the TanStack cache in two tabs, over the WebSocket alone", async () => {
  const one = await app.open();
  const http: string[] = [];
  one.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) http.push(r.url());
  });
  const two = await app.open();
  await one.getByPlaceholder("Write a message…").fill("tanstack one");
  await one.getByRole("button", { name: "Send" }).click();
  await two.getByText("tanstack one").waitFor();
  await two.getByPlaceholder("Write a message…").fill("tanstack two");
  await two.getByRole("button", { name: "Send" }).click();
  await one.getByText("tanstack two").waitFor();
  expect(http).toEqual([]);
  await one.reload();
  await one.getByText("tanstack two").waitFor();
  expect(app.errors).toEqual([]);
});
