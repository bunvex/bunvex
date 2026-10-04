import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, eventually, startApp } from "./index.ts";

// A stand-in for OpenAI's embeddings: each word hashed into one of the 1536 dimensions, normalized.
function embedding(text: string): number[] {
  const out = new Array<number>(1536).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    out[h % 1536]! += 1;
  }
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}
const openai = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no key", { status: 401 });
    const { input } = (await req.json()) as { input: string };
    return Response.json({ data: [{ embedding: embedding(input) }] });
  },
});

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../vector-search"), {
    env: { OPENAI_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${openai.port}` },
  });
});
afterAll(async () => {
  await app?.stop();
  openai.stop(true);
});

test("foods by meaning; movies embedded by a scheduled action, searched, and voted on live", async () => {
  const page = await app.open();
  const foods = page.locator("section").nth(0);
  await foods.getByRole("button", { name: "Add sample foods" }).click();
  await foods.locator("li").nth(4).waitFor();
  await foods.getByPlaceholder("Something spicy…").fill("spicy curry with chillies");
  await foods.getByRole("button", { name: "Search" }).click();
  await foods
    .getByText(/\(0\.\d{3}\)/)
    .first()
    .waitFor();
  expect(await foods.locator("li").first().innerText()).toContain("[indian]");
  const movies = page.locator("section").nth(1);
  await movies.getByRole("button", { name: "Add sample movies" }).click();
  await movies.locator("li").first().waitFor();
  // The embeddings come from scheduled actions: search until they are in.
  await movies.getByPlaceholder("Dreams and heists…").fill("dreams heist");
  await eventually(async () => {
    await movies.getByRole("button", { name: "Search" }).click();
    return (await movies.locator("li").first().innerText()).includes("Dream Heist");
  }, "Dream Heist first");
  const first = movies.locator("li").first();
  const votes = Number((await first.innerText()).match(/(-?\d+) votes/)![1]);
  await first.getByRole("button", { name: "+" }).click();
  await movies
    .locator("li")
    .first()
    .getByText(`${votes + 1} votes`)
    .waitFor();
  expect(app.errors).toEqual([]);
});
