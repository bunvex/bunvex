// The search example end to end (STUDY-90): full-text search whose results follow new messages, live.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
  for (const body of ["the quick brown fox", "a lazy dog sleeps", "foxes are quick", "hello world"])
    await d.http.mutation(api.messages.send, { body, author: "bot" });
});
afterAll(() => d?.stop());

test("matches by relevance, and a new matching message joins the results live", async () => {
  let latest: { body: string }[] | undefined;
  d.client().onUpdate(api.messages.search, { query: "quick fox" }, (r) => {
    latest = r;
  });
  const first = await until(() => latest, "the first results");
  expect(first.map((m) => m.body)).toEqual(["the quick brown fox", "foxes are quick"]);
  await d.http.mutation(api.messages.send, { body: "unrelated", author: "Ada" });
  await d.http.mutation(api.messages.send, { body: "one more quick fox", author: "Ada" });
  const after = await until(() => latest?.length === 3 && latest, "the new match");
  expect(after.map((m) => m.body)).toContain("one more quick fox");
  expect(after.map((m) => m.body)).not.toContain("unrelated");
});

test("no match, and the plain list", async () => {
  expect(await d.http.query(api.messages.search, { query: "zebra" })).toEqual([]);
  expect((await d.http.query(api.messages.list, {})).map((m) => m.body)).toEqual([
    "the quick brown fox",
    "a lazy dog sleeps",
    "foxes are quick",
    "hello world",
    "unrelated",
    "one more quick fox",
  ]);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
