// The TypeScript example end to end (STUDY-90): the schema types the functions and the client; deployed with
// the typecheck on, used through the public client, and its front end typechecked against the generated types.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";
import type { Doc, Id } from "../bunvex/_generated/dataModel.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("typed documents come back live, system fields included", async () => {
  const seen: Doc<"messages">[][] = [];
  d.client().onUpdate(api.messages.list, {}, (messages) => seen.push(messages));
  await until(() => seen.length === 1, "the first result");
  const id: Id<"messages"> = await d.http.mutation(api.messages.send, { body: "typed", author: "Ada" });
  const [message] = await until(() => seen.at(-1)?.length === 1 && seen.at(-1), "the message");
  expect(message).toEqual({ _id: id, _creationTime: expect.any(Number), body: "typed", author: "Ada" });
});

test("the schema is enforced: a field of the wrong type is refused", async () => {
  await expect(d.http.mutation(api.messages.send, { body: 1, author: "Ada" } as never)).rejects.toThrow(
    /ArgumentValidationError/,
  );
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
