// The React Native example end to end (STUDY-90): its functions deployed to a bunvex-local-backend and used through
// the public client, then its app bundled for iOS by Expo's Metro (`expo export`), which must hold nothing of the
// server. The app itself runs on a simulator or a device (README); CI has neither.
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

test("the app typechecks and Metro bundles it for iOS", async () => {
  await build(DIR, { EXPO_PUBLIC_BUNVEX_URL: d.url });
}, 300_000);
