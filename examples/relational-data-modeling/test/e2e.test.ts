// The relational data modeling example end to end (STUDY-90): messages point to their channel by id, each
// channel's list (read through an index, the channel joined in) is live and holds only its own messages.
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

test("each channel sees its own messages, live, with the channel joined in", async () => {
  const general = await d.http.mutation(api.channels.add, { name: "general" });
  const random = await d.http.mutation(api.channels.add, { name: "random" });
  expect((await d.http.query(api.channels.list, {})).map((c) => c.name)).toEqual(["general", "random"]);
  const seen: string[][] = [];
  d.client().onUpdate(api.messages.list, { channel: general }, (ms) =>
    seen.push(ms.map((m) => `${m.channelName}/${m.author}: ${m.body}`)),
  );
  await until(() => seen.length === 1, "the first result");
  await d.http.mutation(api.messages.send, { channel: random, body: "elsewhere", author: "Grace" });
  await d.http.mutation(api.messages.send, { channel: general, body: "hi", author: "Ada" });
  await until(() => seen.at(-1)?.length === 1, "general's message");
  expect(seen.at(-1)).toEqual(["general/Ada: hi"]);
  expect((await d.http.query(api.messages.list, { channel: random })).map((m) => m.body)).toEqual(["elsewhere"]);
});

test("a message's channel must be a channel's id: another table's id is refused", async () => {
  const channel = await d.http.mutation(api.channels.add, { name: "c" });
  await d.http.mutation(api.messages.send, { channel, body: "m", author: "Ada" });
  const [message] = await d.http.query(api.messages.list, { channel });
  await expect(
    d.http.mutation(api.messages.send, { channel: message!._id as never, body: "x", author: "Ada" }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
