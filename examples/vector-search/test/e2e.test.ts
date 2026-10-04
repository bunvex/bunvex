// The vector search example end to end (STUDY-90): embeddings from an action (a local stand-in for OpenAI's
// embeddings API: words hashed into the 1536 dimensions, so texts sharing words are close), vector searches with
// and without filters, and a movie's embedding computed by a scheduled action.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const DIMENSIONS = 1536;

/** A deterministic embedding: each word adds to one dimension (its hash); the vector is normalized. */
function embedding(text: string): number[] {
  const out = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    out[h % DIMENSIONS]! += 1;
  }
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

let embedded = 0;
const openai = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/embeddings") return new Response("not found", { status: 404 });
    if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no key", { status: 401 });
    const { input } = (await req.json()) as { input: string };
    embedded++;
    return Response.json({ data: [{ embedding: embedding(input) }] });
  },
});
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR, { env: { OPENAI_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${openai.port}` } });
});
afterAll(async () => {
  await d?.stop();
  openai.stop(true);
});

test("foods: the closest in meaning first, a cuisine filter, and a new food searchable at once", async () => {
  await d.http.action(api.foods.populate, {});
  expect(embedded).toBe(5);
  const spicy = await d.http.action(api.foods.similar, { query: "spicy curry with chillies" });
  expect(spicy[0]!.cuisine).toBe("indian");
  expect(spicy[0]!._score).toBeGreaterThan(spicy[1]!._score);
  const italian = await d.http.action(api.foods.similar, { query: "spicy curry with chillies", cuisines: ["italian"] });
  expect(italian.map((f) => f.cuisine)).toEqual(["italian"]);
  const both = await d.http.action(api.foods.similar, { query: "chicken", cuisines: ["indian", "japanese"] });
  expect(both.map((f) => f.cuisine).sort()).toEqual(["indian", "japanese"]);

  await d.http.action(api.foods.insert, { cuisine: "thai", description: "Green curry with basil and lime leaves." });
  const green = await d.http.action(api.foods.similar, { query: "green curry basil" });
  expect(green[0]!.description).toBe("Green curry with basil and lime leaves.");
  expect((await d.http.query(api.foods.list, {}))[0]!.cuisine).toBe("thai");
});

test("foods: an unknown cuisine is refused", async () => {
  await expect(d.http.action(api.foods.insert, { cuisine: "martian", description: "Red dust." })).rejects.toThrow(
    "Unknown cuisine: martian",
  );
});

test("movies: saved at once, embedded by a scheduled action, then found; votes show live in the results", async () => {
  let movies: { title: string; embeddingId?: string }[] | undefined;
  d.client().onUpdate(api.movies.list, {}, (r) => {
    movies = r;
  });
  await d.http.action(api.movies.populate, {});
  // Each movie shows at once; its embedding id arrives when its scheduled action has run.
  await until(() => movies?.length === 4 && movies.every((m) => m.embeddingId), "every movie embedded");
  const hits = await d.http.action(api.movies.similar, { query: "steal secrets from dreams" });
  const found = await d.http.query(api.movies.withScores, { results: hits });
  expect(found[0]!.title).toBe("Dream Heist");
  const drama = await d.http.action(api.movies.similar, { query: "steal secrets from dreams", genres: ["Drama"] });
  expect((await d.http.query(api.movies.withScores, { results: drama })).map((m) => m.genre)).toEqual(["Drama"]);

  let live: { title: string; votes: number }[] | undefined;
  d.client().onUpdate(api.movies.withScores, { results: hits }, (r) => {
    live = r;
  });
  await until(() => live, "the results");
  await d.http.mutation(api.movies.vote, { id: found[0]!._id, delta: 1 });
  await until(() => live?.[0]?.votes === 1, "the vote");
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
