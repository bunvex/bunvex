// The GIF chat end to end (STUDY-90): an action calls Giphy — here a local stand-in, so the test needs no
// network and no key — and posts the GIF through an internal mutation.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const asked: URLSearchParams[] = [];
// Answers as Giphy's translate endpoint does: one GIF per phrase.
const giphy = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/gifs/translate") return new Response("not found", { status: 404 });
    asked.push(url.searchParams);
    if (url.searchParams.get("api_key") !== "test-key")
      return Response.json({ meta: { status: 401, msg: "Unauthorized" } }, { status: 401 });
    return Response.json({ data: { embed_url: `https://giphy.test/embed/${url.searchParams.get("s")}` } });
  },
});
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR, { env: { GIPHY_KEY: "test-key", GIPHY_BASE_URL: `http://127.0.0.1:${giphy.port}` } });
});
afterAll(async () => {
  await d?.stop();
  giphy.stop(true);
});

test("sendGif asks Giphy with the key and posts its GIF, live", async () => {
  let latest: { author: string; body: string; format: string }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest, "the first result");
  await d.http.mutation(api.messages.send, { body: "look", author: "Ada" });
  await d.http.action(api.messages.sendGif, { queryString: "happy cat", author: "Ada" });
  const both = await until(() => latest?.length === 2 && latest, "the GIF message");
  expect(both.map((m) => [m.format, m.body])).toEqual([
    ["text", "look"],
    ["giphy", "https://giphy.test/embed/happy cat"],
  ]);
  expect(asked.at(-1)?.get("api_key")).toBe("test-key");
});

test("a failing Giphy call fails the action, and posts nothing", async () => {
  const before = (await d.http.query(api.messages.list, {})).length;
  await d.cli("env", "set", "GIPHY_KEY", "wrong-key", "--force");
  await expect(d.http.action(api.messages.sendGif, { queryString: "dog", author: "Ada" })).rejects.toThrow(
    /Giphy failed/,
  );
  expect(await d.http.query(api.messages.list, {})).toHaveLength(before);
  await d.cli("env", "set", "GIPHY_KEY", "test-key", "--force");
});

test("without GIPHY_KEY, the action says how to set it, and calls nothing", async () => {
  const calls = asked.length;
  await d.cli("env", "remove", "GIPHY_KEY");
  await expect(d.http.action(api.messages.sendGif, { queryString: "dog", author: "Ada" })).rejects.toThrow(
    "GIPHY_KEY is not set: run `bunx bunvex env set GIPHY_KEY <value>` in this example's directory.",
  );
  expect(asked).toHaveLength(calls);
  await d.cli("env", "set", "GIPHY_KEY", "test-key", "--force");
});

test("the GIF mutation is internal: a client cannot call it", async () => {
  await expect(
    d.http.mutation("messages:sendGifMessage" as never, { body: "x", author: "Mallory" } as never),
  ).rejects.toThrow(/Could not find public function/);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
