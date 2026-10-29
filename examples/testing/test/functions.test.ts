// The testing example (STUDY-159 PR 4): each test runs the app's functions on a deployment of its own, inside the
// test's process, with `@bunvex/testing` — the scenarios of convex-test's demo, written for bunvex.
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { api, internal } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
/** A deployment of this app for one test (closed after it). */
function setup(env?: Record<string, string>) {
  const t = bunvexTest({ cwd: DIR, env });
  open.push(t);
  return t;
}

test("posts: none at first, then newest first", async () => {
  const t = setup();
  expect(await t.query(api.posts.list)).toEqual([]);
  // Internal functions can be called from a test.
  await t.mutation(internal.posts.add, { title: "First", content: "one", author: "Ada" });
  await t.mutation(internal.posts.add, { title: "Second", content: "two", author: "Grace" });
  expect((await t.query(api.posts.list)).map((p) => p.title)).toEqual(["Second", "First"]);
});

test("tasks: each user sees their own", async () => {
  const t = setup();
  const ada = t.withIdentity({ name: "Ada" });
  await ada.mutation(api.tasks.create, { text: "Write tests" });
  expect(await ada.query(api.tasks.mine)).toMatchObject([{ text: "Write tests", author: "Ada" }]);
  expect(await t.withIdentity({ name: "Grace" }).query(api.tasks.mine)).toEqual([]);
  await expect(t.query(api.tasks.mine)).rejects.toThrow("Sign in to see your tasks");
});

test("t.run: set up and read the data directly", async () => {
  const t = setup();
  const first = await t.run(async (ctx) => {
    await ctx.db.insert("tasks", { text: "Eat breakfast" });
    return await ctx.db.query("tasks").first();
  });
  expect(first).toMatchObject({ text: "Eat breakfast" });
});

test("a refused message fails with the app's error", async () => {
  const t = setup();
  await expect(t.mutation(api.messages.send, { body: " ", author: "Ada" })).rejects.toThrow(
    "A message needs some text",
  );
});

test("a scheduled action runs once the clock reaches it", async () => {
  const t = setup();
  const id = await t.mutation(api.scheduler.later, { delayMs: 10_000 });
  const state = async () =>
    (await t.run(async (ctx) => (await ctx.db.system.get(id))?.state)) as { kind: string } | undefined;
  await t.advanceTime(5000);
  expect(await state()).toEqual({ kind: "pending" });
  await t.advanceTime(6000);
  expect(await state()).toEqual({ kind: "success" });
});

test("scheduled functions that schedule more run to the end", async () => {
  const t = setup();
  await t.mutation(api.scheduler.chain);
  await t.finishAllScheduledFunctions();
  expect(await t.run(async (ctx) => await ctx.db.query("tasks").first())).toMatchObject({ author: "scheduler" });
});

test("HTTP actions, anonymous or as a user", async () => {
  const t = setup();
  expect(await (await t.fetch("/hello", { method: "POST" })).text()).toBe("Hello, stranger!");
  expect(await (await t.withIdentity({ name: "Ada" }).fetch("/hello", { method: "POST" })).text()).toBe("Hello, Ada!");
});

test("an action that calls a service: the test serves it, and passes its address in the env", async () => {
  // The app's code runs in its own context, as on a deployment: replacing the test's `fetch` does not reach it.
  // The test runs a stand-in service instead, and gives the action its address through the deployment's env.
  const assistant = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => new Response(`You said: ${await req.text()}`),
  });
  try {
    const t = setup({ ASSISTANT_URL: `http://127.0.0.1:${assistant.port}/` });
    expect(await t.action(api.messages.ask, { prompt: "hello" })).toBe("You said: hello");
  } finally {
    assistant.stop(true);
  }
});
