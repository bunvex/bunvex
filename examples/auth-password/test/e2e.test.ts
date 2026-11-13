// The username + password example end to end, on a deployment of its own: the auth components installed from the
// workspace; sign-up and sign-in over HTTP; the access token they return accepted by the deployment itself (verified
// against its own keys through `auth.config.ts`), until its session is signed out; a refresh's new token too; the front
// end typechecks and builds.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexHttpClient } from "@bunvex/client";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const PASSWORD = "correct horse battery staple";
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

/** A client calling as the holder of `token`, as the browser's provider does. */
function as(token: string) {
  const client = new BunvexHttpClient(d.url, { logger: false });
  client.setAuth(token);
  return client;
}
const payloadOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());

test("sign up, then calls as the user with the access token the deployment verifies", async () => {
  const up = await d.http.mutation(api.auth.signUpWithUsernamePassword, { username: "Ada", password: PASSWORD });
  if (up.status !== "complete") throw new Error(`sign-up failed: ${JSON.stringify(up)}`);
  const claims = payloadOf(up.tokens.accessToken);
  expect(claims.aud).toBe("bunvex-auth");
  expect(claims.iss).toMatch(/\/components\/auth$/);
  const ada = as(up.tokens.accessToken);
  expect(await ada.query(api.currentUser.loggedInUser, {})).toMatchObject({ id: up.tokens.userId, username: "Ada" });
  expect(await ada.query(api.auth.isAuthenticated, {})).toBe(true);
  // Signed out: the token still verifies, but its session is gone.
  await d.http.mutation(api.auth.signOut, { refreshToken: up.tokens.refreshToken });
  expect(await ada.query(api.currentUser.loggedInUser, {})).toBeNull();
  expect(await ada.query(api.auth.isAuthenticated, {})).toBe(false);
});

test("sign in, refresh: the new access token is accepted too; a wrong password is refused", async () => {
  await d.http.mutation(api.auth.signUpWithUsernamePassword, { username: "grace", password: PASSWORD });
  expect(
    await d.http.mutation(api.auth.signInWithUsernamePassword, { username: "grace", password: "wrong horse battery" }),
  ).toEqual({ status: "error", userError: { error: "INVALID_CREDENTIALS" } });
  const back = await d.http.mutation(api.auth.signInWithUsernamePassword, { username: "GRACE", password: PASSWORD });
  if (back.status !== "complete") throw new Error(`sign-in failed: ${JSON.stringify(back)}`);
  const refreshed = await d.http.mutation(api.auth.refreshSession, { refreshToken: back.tokens.refreshToken });
  if (refreshed.kind !== "rotated") throw new Error(`refresh failed: ${JSON.stringify(refreshed)}`);
  expect(await as(refreshed.tokens.accessToken).query(api.currentUser.loggedInUser, {})).toMatchObject({
    username: "grace",
  });
});

test("the front end typechecks and builds", () => build(DIR), 120_000);
