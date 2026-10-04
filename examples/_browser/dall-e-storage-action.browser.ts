import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, imageWidth, PNG, startApp } from "./index.ts";

// A stand-in for OpenAI: moderation (a prompt with "forbidden" is flagged), image generation, the image itself.
const openai = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/image.png") return new Response(PNG.buffer, { headers: { "content-type": "image/png" } });
    if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no key", { status: 401 });
    if (url.pathname === "/v1/moderations") {
      const { input } = (await req.json()) as { input: string };
      const flagged = input.includes("forbidden");
      return Response.json({ results: [{ flagged, categories: { violence: flagged } }] });
    }
    if (url.pathname === "/v1/images/generations")
      return Response.json({ data: [{ url: `http://127.0.0.1:${openai.port}/image.png` }] });
    return new Response("not found", { status: 404 });
  },
});

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../dall-e-storage-action"), {
    env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${openai.port}` },
  });
});
afterAll(async () => {
  await app?.stop();
  openai.stop(true);
});

test("/image posts a generated image, stored and served back", async () => {
  const page = await app.open();
  await page.getByPlaceholder("Write a message, or /image …").fill("/image a cat in a hat");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator("li img").first().waitFor();
  expect(await imageWidth(page, "li img")).toBe(1);
  const src = await page.locator("li img").first().getAttribute("src");
  expect((await fetch(src!)).headers.get("content-type")).toBe("image/png");
  expect(app.errors).toEqual([]);
});
