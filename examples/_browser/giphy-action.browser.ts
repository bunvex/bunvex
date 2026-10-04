import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, startApp } from "./index.ts";

// A stand-in for Giphy's translate API.
const giphy = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/embed/"))
      return new Response("<p>a gif</p>", { headers: { "content-type": "text/html" } });
    if (url.searchParams.get("api_key") !== "test-key")
      return Response.json({ meta: { status: 401 } }, { status: 401 });
    return Response.json({ data: { embed_url: `http://127.0.0.1:${giphy.port}/embed/${url.searchParams.get("s")}` } });
  },
});

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../giphy-action"), {
    env: { GIPHY_KEY: "test-key", GIPHY_BASE_URL: `http://127.0.0.1:${giphy.port}` },
  });
});
afterAll(async () => {
  await app?.stop();
  giphy.stop(true);
});

test("a text message, then /giphy posts a GIF, live in a second tab", async () => {
  const one = await app.open();
  const two = await app.open();
  const input = one.getByPlaceholder("Write a message, or /giphy …");
  await input.fill("hello");
  await one.getByRole("button", { name: "Send" }).click();
  await two.getByText("hello").waitFor();
  await input.fill("/giphy dogs");
  await one.getByRole("button", { name: "Send" }).click();
  await two.locator("iframe").waitFor();
  expect(await two.locator("iframe").getAttribute("src")).toContain("/embed/dogs");
  expect(app.errors).toEqual([]);
});
