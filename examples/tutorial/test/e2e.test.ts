// The tutorial end to end (STUDY-90): deployed to a bunvex-local-backend, used through the public client.
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

test("messages show up live, in order, for every subscriber", async () => {
  const seen: { author: string; body: string }[][] = [];
  d.client().onUpdate(api.messages.list, {}, (messages) => seen.push(messages));
  await until(() => seen.length === 1, "the first result");
  expect(seen[0]).toEqual([]);
  await d.http.mutation(api.messages.send, { body: "hi", author: "Ada" });
  await d.http.mutation(api.messages.send, { body: "hello", author: "Grace" });
  const last = await until(() => seen.at(-1)?.length === 2 && seen.at(-1), "both messages");
  expect(last.map((m) => `${m.author}: ${m.body}`)).toEqual(["Ada: hi", "Grace: hello"]);
});

test("the list keeps the 50 most recent, oldest first", async () => {
  for (let i = 0; i < 55; i++) await d.http.mutation(api.messages.send, { body: `m${i}`, author: "bot" });
  const list = await d.http.query(api.messages.list, {});
  expect(list).toHaveLength(50);
  expect(list.at(0)?.body).toBe("m5");
  expect(list.at(-1)?.body).toBe("m54");
});

test("send's arguments are validated", async () => {
  await expect(d.http.mutation(api.messages.send, { body: "no author" } as never)).rejects.toThrow(
    /ArgumentValidationError|missing the required field `author`/,
  );
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
