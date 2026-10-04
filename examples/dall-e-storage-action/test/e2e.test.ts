// The generated-images chat end to end (STUDY-90): an action checks the prompt, asks for an image, downloads it
// and keeps it in file storage — against a local stand-in for OpenAI, so no network and no key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7]);
const calls: string[] = [];
// Answers as OpenAI's moderation and image endpoints do; "forbidden" prompts are flagged.
const openai = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/image.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
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
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR, { env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${openai.port}` } });
});
afterAll(async () => {
  await d?.stop();
  openai.stop(true);
});

test("a generated image is checked, downloaded, stored, and shows up live with its stored URL", async () => {
  let latest: { format: string; prompt?: string; url: string | null }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest, "the first result");
  calls.length = 0;
  await d.http.action(api.images.send, { prompt: "a cat in a hat", author: "Ada" });
  expect(calls).toEqual(["POST /v1/moderations", "POST /v1/images/generations", "GET /image.png"]);
  const [message] = await until(() => latest?.length === 1 && latest, "the image message");
  expect([message!.format, message!.prompt]).toEqual(["dall-e", "a cat in a hat"]);
  // Served from the deployment's file storage, not from the (expiring) generated URL.
  expect(message!.url).toStartWith(d.url);
  const served = await fetch(message!.url!);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
});

test("a flagged prompt fails the action before any image is asked for", async () => {
  const before = (await d.http.query(api.messages.list, {})).length;
  calls.length = 0;
  await expect(d.http.action(api.images.send, { prompt: "something forbidden", author: "Ada" })).rejects.toThrow(
    'Your prompt was flagged: {"violence":true}',
  );
  expect(calls).toEqual(["POST /v1/moderations"]);
  expect(await d.http.query(api.messages.list, {})).toHaveLength(before);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
