// `bunvexTest` (STUDY-159 PR 2) on a small app (fixtures/app): convex-test's API, each test a deployment of its own
// with the app pushed as `bunvex deploy` pushes it.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "../src/index.ts";

const APP = join(import.meta.dir, "fixtures", "app");
const api = anyApi;

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const make = (env?: Record<string, string>) => {
  const t = bunvexTest({ cwd: APP, env });
  open.push(t);
  return t;
};

describe("bunvexTest", () => {
  test("queries and mutations by reference, on the pushed app", async () => {
    const t = make();
    expect(await t.query(api.messages.list)).toEqual([]);
    await t.mutation(api.messages.send, { body: "hi" });
    expect(await t.query(api.messages.list)).toEqual(["anonymous: hi"]);
  });

  test("each test object is a deployment of its own", async () => {
    const a = make();
    const b = make();
    await a.mutation(api.messages.send, { body: "only in a" });
    expect(await b.query(api.messages.list)).toEqual([]);
  });

  test("withIdentity: the user's fields, with convex-test's defaults in bunvex's words", async () => {
    const t = make();
    await t.withIdentity({ name: "Ada" }).mutation(api.messages.send, { body: "hello" });
    expect(await t.query(api.messages.list)).toEqual(["Ada: hello"]);
    const identity = await t
      .withIdentity({ subject: "u1" })
      .query(async (ctx: { auth: { getUserIdentity(): unknown } }) => ctx.auth.getUserIdentity());
    expect(identity).toMatchObject({
      subject: "u1",
      issuer: "https://bunvex.test",
      tokenIdentifier: "https://bunvex.test|u1",
    });
  });

  test("withRequestMetadata: a mutation sees the client's address and user agent", async () => {
    const t = make();
    expect(await t.mutation(api.messages.requestMeta)).toEqual({ ip: null, userAgent: null });
    const r = t.withIdentity({ name: "Ada" }).withRequestMetadata({ ip: "203.0.113.7", userAgent: "tests/1.0" });
    expect(await r.mutation(api.messages.requestMeta)).toEqual({ ip: "203.0.113.7", userAgent: "tests/1.0" });
  });

  test("results come back as a client receives them: undefined is null, undefined fields are gone", async () => {
    const t = make();
    expect(await t.run(async () => undefined)).toBeNull();
    const r: object = await t.run(async () => ({ kept: 1, gone: undefined, nested: { gone: undefined, n: 2n } }));
    expect(r).toStrictEqual({ kept: 1, nested: { n: 2n } });
    expect("gone" in r).toBe(false);
  });

  test("internal functions may be called, as in convex-test", async () => {
    const t = make();
    await t.mutation(api.messages.send, { body: "x" });
    await t.mutation(api.messages.wipe);
    expect(await t.query(api.messages.list)).toEqual([]);
  });

  test("t.run: an inline mutation sees the app's tables", async () => {
    const t = make();
    await t.run(async (ctx: { db: { insert(t: string, d: object): Promise<unknown> } }) =>
      ctx.db.insert("messages", { body: "seeded", author: "test" }),
    );
    expect(await t.query(api.messages.list)).toEqual(["test: seeded"]);
  });

  test("the schema is the app's: a document it refuses fails as on a deployment", async () => {
    const t = make();
    const err = await t
      .run(async (ctx: { db: { insert(t: string, d: object): Promise<unknown> } }) =>
        ctx.db.insert("messages", { body: 1 }),
      )
      .catch((e: Error) => e.message);
    expect(err).toContain("Object is missing the required field `author`");
  });

  test("an action runs, and its mutations commit", async () => {
    const t = make();
    await t.action(api.messages.sendTwice, { body: "twice" });
    expect(await t.query(api.messages.list)).toEqual(["anonymous: twice", "anonymous: twice"]);
  });

  test("errors reach the test as thrown errors", async () => {
    const t = make();
    expect(await t.mutation(api.messages.reject).catch((e: Error) => e.message)).toContain("rejected on purpose");
  });

  test("the deployment's env (AD-34): functions see what bunvexTest was given, not process.env", async () => {
    process.env.GREETING = "from the host";
    try {
      expect(await make().query(api.messages.greeting)).toBeNull();
      const t = make({ GREETING: "hello" });
      expect(await t.query(api.messages.greeting)).toBe("hello");
      await t.setEnv("GREETING", "hi again");
      expect(await t.query(api.messages.greeting)).toBe("hi again");
      await t.setEnv("GREETING", null);
      expect(await t.query(api.messages.greeting)).toBeNull();
    } finally {
      delete process.env.GREETING;
    }
  });

  test("t.fetch reaches the app's HTTP actions", async () => {
    const t = make();
    await t.mutation(api.messages.send, { body: "x" });
    const r = await t.fetch("/count");
    expect([r.status, await r.text()]).toEqual([200, "1"]);
    expect((await t.fetch("/nope")).status).toBe(404);
  });

  test("t.fetch runs as withIdentity's user, as convex-test", async () => {
    const t = make();
    expect(await (await t.fetch("/whoami")).json()).toBeNull();
    expect(await (await t.withIdentity({ name: "Ada" }).fetch("/whoami")).json()).toBe("Ada");
  });

  test("scheduled functions run on the virtual clock, when finished", async () => {
    const t = make();
    const start = t.now();
    await t.mutation(api.messages.sendLater, { body: "later", delayMs: 3600_000 });
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.messages.list)).toEqual([]);
    await t.finishAllScheduledFunctions();
    expect(await t.query(api.messages.list)).toEqual(["anonymous: later"]);
    expect(t.now() - start).toBeGreaterThanOrEqual(3600_000);
    expect(t.now() - start).toBeLessThan(3600_000 + 1000);
  });

  test("advanceTime: what is due by then runs, nothing later", async () => {
    const t = make();
    await t.mutation(api.messages.sendLater, { body: "in an hour", delayMs: 3600_000 });
    await t.advanceTime(3600_000 - 10);
    expect(await t.query(api.messages.list)).toEqual([]);
    await t.advanceTime(20);
    expect(await t.query(api.messages.list)).toEqual(["anonymous: in an hour"]);
  });

  test("crons (AD-35): runCron runs one now; due crons run as the clock moves", async () => {
    const t = make();
    expect(await t.query(api.messages.ticks)).toBe(0);
    await t.runCron("tick");
    expect(await t.query(api.messages.ticks)).toBe(1);
    expect(await t.runCron("nope").catch((e: Error) => e.message)).toBe('bunvexTest: no cron job named "nope"');
    // An interval cron runs at once, then every hour: moving the clock two hours runs it three more times.
    await t.mutation(api.messages.sendLater, { body: "later", delayMs: 2 * 3600_000 });
    await t.finishAllScheduledFunctions();
    expect(await t.query(api.messages.ticks)).toBe(4);
  });
});
