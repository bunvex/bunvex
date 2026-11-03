// The anonymous example end to end, on a deployment of its own: an anonymous sign-in over HTTP, its access token
// accepted by the deployment itself (verified through `auth.config.ts`) for the app's own mutation, refused once signed
// out; the front end typechecks and builds.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexHttpClient } from "@bunvex/client";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("an anonymous user counts visits with its access token, until signed out", async () => {
  const { tokens } = await d.http.mutation(api.auth.signInAnonymously, {});
  const visitor = new BunvexHttpClient(d.url, { logger: false });
  visitor.setAuth(tokens.accessToken);
  expect(await visitor.mutation(api.users.visit, {})).toBe(1);
  expect((await visitor.query(api.users.me, {}))?.visits).toBe(1);
  await d.http.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
  await expect(visitor.mutation(api.users.visit, {})).rejects.toThrow("Sign in first");
});

test("the front end typechecks and builds", () => build(DIR), 120_000);
