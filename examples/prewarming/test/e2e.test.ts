// The prewarming example end to end (STUDY-90): `prewarmQuery` subscribes ahead of the view, so the result is
// in the client before anything renders it, and the subscription ends after `extendSubscriptionFor`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexReactClient } from "bunvex/react";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
let client: BunvexReactClient;
beforeAll(async () => {
  d = await deploy(DIR);
  client = new BunvexReactClient(d.url, { logger: false, unsavedChangesWarning: false });
});
afterAll(async () => {
  await client?.close();
  await d?.stop();
});

test("without prewarming, nothing is in the client until a view subscribes", async () => {
  await d.http.mutation(api.messages.send, { body: "hi", author: "Ada" });
  await Bun.sleep(100);
  expect(client.watchQuery(api.messages.list, {}).localQueryResult()).toBeUndefined();
});

test("prewarmed: the result arrives, and stays live, before any view reads it", async () => {
  client.prewarmQuery({ query: api.messages.list, args: {}, extendSubscriptionFor: 2_000 });
  const watch = client.watchQuery(api.messages.list, {});
  const first = await until(() => watch.localQueryResult(), "the prewarmed result");
  expect(first.map((m) => m.body)).toEqual(["hi"]);
  await d.http.mutation(api.messages.send, { body: "again", author: "Ada" });
  await until(() => watch.localQueryResult()?.length === 2, "the live update");
});

test("the prewarm subscription ends after extendSubscriptionFor", async () => {
  const other = new BunvexReactClient(d.url, { logger: false, unsavedChangesWarning: false });
  try {
    other.prewarmQuery({ query: api.messages.list, args: {}, extendSubscriptionFor: 50 });
    const watch = other.watchQuery(api.messages.list, {});
    await until(() => watch.localQueryResult(), "the prewarmed result");
    await until(() => watch.localQueryResult() === undefined, "the subscription to end");
  } finally {
    await other.close();
  }
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
