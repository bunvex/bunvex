// The HTTP actions example end to end (STUDY-90): messages posted and read over HTTP on the deployment's site
// origin, alongside the sync client.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("a message POSTed to an HTTP action shows up live", async () => {
  let latest: { author: string; body: string }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest, "the first result");
  const r = await fetch(`${d.siteUrl}/postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: "User 7", body: "hello" }),
  });
  expect(r.status).toBe(200);
  const list = await until(() => latest?.length === 1 && latest, "the posted message");
  expect(list.map((m) => [m.author, m.body])).toEqual([["User 7", "Sent over HTTP: hello"]]);
});

test("a user's messages over HTTP: by query parameter, by header, by path suffix", async () => {
  await d.http.mutation(api.messages.send, { body: "mine", author: "User 7" });
  await d.http.mutation(api.messages.send, { body: "not mine", author: "User 8" });
  const expected = [
    { body: "Sent over HTTP: hello", author: "User 7" },
    { body: "mine", author: "User 7" },
  ];
  const byParam = await fetch(`${d.siteUrl}/getMessagesByAuthor?authorNumber=7`);
  expect(byParam.headers.get("content-type")).toContain("application/json");
  expect(await byParam.json()).toEqual(expected);
  const byHeader = await fetch(`${d.siteUrl}/getMessagesByAuthor`, { headers: { authorNumber: "7" } });
  expect(await byHeader.json()).toEqual(expected);
  const bySuffix = await fetch(`${d.siteUrl}/getAuthorMessages/7`);
  expect(await bySuffix.json()).toEqual(expected);
  expect(await (await fetch(`${d.siteUrl}/getAuthorMessages/8`)).json()).toEqual([
    { body: "not mine", author: "User 8" },
  ]);
});

test("a request without the author's number is a 400; an unrouted path a 404", async () => {
  const r = await fetch(`${d.siteUrl}/getMessagesByAuthor`);
  expect(r.status).toBe(400);
  expect(await r.text()).toBe("Give authorNumber as a query parameter or a header");
  expect((await fetch(`${d.siteUrl}/nowhere`)).status).toBe(404);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
