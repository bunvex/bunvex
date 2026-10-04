// The custom errors example end to end (STUDY-90): a `BunvexError`'s data reaches the client as it was thrown,
// from a mutation and from a live query.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexError } from "bunvex/values";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("a mutation's BunvexError of a string: the client gets the string", async () => {
  const e = await d.http.mutation(api.messages.send, { body: "x".repeat(51), author: "Ada" }).catch((x) => x);
  expect(e).toBeInstanceOf(BunvexError);
  expect((e as BunvexError<string>).data).toBe("A message is at most 50 characters.");
  expect(await d.http.query(api.messages.list, {})).toEqual([]);
});

test("a query's BunvexError of an object reaches a live subscriber, then clears", async () => {
  const values: number[] = [];
  const errors: unknown[] = [];
  d.client().onUpdate(
    api.messages.list,
    {},
    (messages) => values.push(messages.length),
    (e) => errors.push(e),
  );
  await until(() => values.length === 1, "the first result");
  for (let i = 0; i < 21; i++) await d.http.mutation(api.messages.send, { body: `m${i}`, author: "bot" });
  const [error] = await until(() => errors.length > 0 && errors, "the error");
  expect(error).toBeInstanceOf(BunvexError);
  expect((error as BunvexError<{ code: string; message: string; count: number }>).data).toEqual({
    code: "TOO_MANY_MESSAGES",
    message: "Too many messages!",
    count: 21,
  });
  await d.http.mutation(api.messages.clear, {});
  await until(() => values.at(-1) === 0 && values.length > 1, "the list again, empty");
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
