// The argument validation example end to end (STUDY-90): calls the validators refuse never reach the handler
// (nothing is written), and `returns` is checked.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("valid calls go through, the optional field left out or given", async () => {
  expect(await d.http.mutation(api.messages.send, { body: "plain", author: "Ada" })).toBeNull();
  await d.http.mutation(api.messages.send, { body: "tagged", author: "Ada", tags: ["a", "b"] });
  const list = await d.http.query(api.messages.list, {});
  expect(list.map((m) => [m.body, m.tags])).toEqual([
    ["plain", []],
    ["tagged", ["a", "b"]],
  ]);
  expect(await d.http.query(api.messages.count, {})).toBe(2);
});

test("a missing field, a wrong type and an extra field are refused, and nothing is written", async () => {
  const before = await d.http.query(api.messages.count, {});
  const send = (args: unknown) => d.http.mutation(api.messages.send, args as never);
  await expect(send({ body: "no author" })).rejects.toThrow(/ArgumentValidationError[\s\S]*author/);
  await expect(send({ body: 42, author: "Ada" })).rejects.toThrow(/ArgumentValidationError[\s\S]*body/);
  await expect(send({ body: "x", author: "Ada", tags: [1] })).rejects.toThrow(/ArgumentValidationError[\s\S]*tags/);
  await expect(send({ body: "x", author: "Ada", extra: true })).rejects.toThrow(/ArgumentValidationError[\s\S]*extra/);
  expect(await d.http.query(api.messages.count, {})).toBe(before);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
