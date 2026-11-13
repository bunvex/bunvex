import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, type Page, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../auth-password"));
});
afterAll(() => app?.stop());

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a different horse entirely";

async function signIn(page: Page, mode: "Sign in" | "Sign up", password: string) {
  if (mode === "Sign up") await page.getByRole("button", { name: "No account yet? Sign up" }).click();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page.getByText("Signed in as").waitFor();
}

// Each tab is a browser context of its own: two sessions of one user. STUDY-208 §1.10: the provider subscribes to the
// app's `isAuthenticated`, so a session revoked on the server signs its tab out at once, without a reload, long before
// its access token expires.
test("changing the password with “sign out my other sessions” signs the other tab out at once", async () => {
  const one = await app.open();
  const two = await app.open();
  await signIn(one, "Sign up", PASSWORD);
  await signIn(two, "Sign in", PASSWORD);

  // Changed without signing out the others: the other tab stays signed in.
  await one.getByLabel("Current password").fill(PASSWORD);
  await one.getByLabel("New password").fill(NEW_PASSWORD);
  await one.getByRole("button", { name: "Change password" }).click();
  await one.getByText("Password changed.").waitFor();
  await Bun.sleep(500);
  expect(await two.getByText("Signed in as").isVisible()).toBe(true);

  await one.getByLabel("Current password").fill(NEW_PASSWORD);
  await one.getByLabel("New password").fill(PASSWORD);
  await one.getByLabel("Sign out my other sessions").check();
  await one.getByRole("button", { name: "Change password" }).click();
  await one.getByText("Password changed.").waitFor();

  // The other tab is back at the sign-in form, its stored session gone; this one is still signed in.
  await two.getByRole("heading", { name: "Sign in" }).waitFor();
  expect(
    await two.evaluate(() => Object.keys(localStorage).filter((k) => /^__bunvexAuth(JWT|RefreshToken)/.test(k))),
  ).toEqual([]);
  expect(await one.getByText("Signed in as").isVisible()).toBe(true);
  await one.reload();
  await one.getByText("Signed in as").waitFor();
  expect(app.errors).toEqual([]);
});
