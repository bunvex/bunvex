// The dashboard image's sign-in, in Chromium (docker/smoke-dashboard.sh, STUDY-149 PR 7): the page the image
// serves comes with the backend's URL filled in (its BUNVEX_DEPLOYMENT_URL), the admin key is pasted, and the
// dashboard opens on the deployment, as an operator does after `docker compose up`.
//   bun apps/dashboard/e2e/sign-in-smoke.ts <dashboard URL> <backend URL> <admin key> <instance name>
// The system Chrome, or Playwright's Chromium with E2E_BROWSER=chromium (CI).
import { chromium } from "playwright-core";

const [dashboardUrl, backendUrl, adminKey, instance] = process.argv.slice(2);
if (!dashboardUrl || !backendUrl || !adminKey || !instance)
  throw new Error("usage: sign-in-smoke.ts <dashboard URL> <backend URL> <admin key> <instance name>");

const browser = await chromium.launch(process.env.E2E_BROWSER === "chromium" ? {} : { channel: "chrome" });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // opened on the Data screen of the table the smoke test wrote: signed in, the dashboard opens there
  await page.goto(`${dashboardUrl.replace(/\/$/, "")}/database/items`);
  await page.getByRole("heading", { level: 1, name: "Sign in to a deployment" }).waitFor();
  const prefilled = await page.getByLabel("Deployment URL", { exact: true }).inputValue();
  if (prefilled !== backendUrl) throw new Error(`the deployment URL is "${prefilled}", not ${backendUrl}`);
  await page.getByLabel("Admin key", { exact: true }).fill(adminKey);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { level: 1, name: "items" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: `Signed in: ${instance}` }).waitFor();
  await page.getByRole("gridcell").filter({ hasText: /^42$/ }).first().waitFor();
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("sign-in smoke: ok");
} finally {
  await browser.close();
}
