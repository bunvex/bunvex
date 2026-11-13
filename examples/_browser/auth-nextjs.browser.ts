import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, eventually, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../auth-nextjs"));
});
afterAll(() => app?.stop());

// STUDY-208 §1.10: the server provider hands the client provider the name of the app's `isAuthenticated`, which it
// subscribes to; a session revoked on the server signs the page out at once, and the sign-out route clears its cookies.
test("a session revoked on the server signs the page out and clears its cookies", async () => {
  const page = await app.open("/signin");
  await page.getByRole("button", { name: "No account yet? Sign up" }).click();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByTestId("user").getByText("ada").waitFor();
  const authCookies = async () => (await page.context().cookies()).filter((c) => c.name.includes("__bunvexAuth"));
  const refresh = (await authCookies()).find((c) => c.name.includes("RefreshToken"));
  if (refresh === undefined) throw new Error("no refresh token cookie");

  // Elsewhere, the session is signed out with its refresh token: the page's subscription answers `false`.
  await app.d.http.mutation("auth:signOut" as never, { refreshToken: refresh.value } as never);

  await page.getByText("none", { exact: true }).waitFor();
  await eventually(async () => (await authCookies()).length === 0, "the auth cookies cleared");
  // `next dev` also logs that it could not validate the instant UI of Cache Components, on every page and before this
  // change too: its check trips on the lazily imported client provider ("the module factory is not available").
  expect(app.errors.filter((e) => !/validate `instant`|validate instant UI/.test(e))).toEqual([]);
});
