// The dashboard on another origin than its deployment, in Chromium (STUDY-67 §9): the app as a release ships it,
// served by the real `bunvex dashboard serve` on one port, signed in by hand to a bunvex server on another, as the
// dashboard image (6791) and a deployment (3210) are on every real install. Every admin request is then a CORS
// request with a preflight (the admin key and the client header are not simple headers). The header must show the
// deployment (its name, persistence and version: `/instance_name`, `/stats`, `/instance_version`), not "Deployment
// unavailable"; the Overview's metrics (`/api/app_metrics/*`) and its live counters (`/stats`) must load; and no
// request to the deployment may fail in the browser. Before the fix, `/version` (outside Convex's CORS layer) and
// `/stats` (no layer at all) failed their asked, and the header said "Deployment unavailable".
//
// Not a `*.test.ts`: it needs a browser and builds the app, so it runs with the dashboard's browser tests (`bun run
// e2e`, CI's "e2e · dashboard in Chromium"): the system Chrome locally, Playwright's Chromium in CI
// (`E2E_BROWSER=chromium`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { type LiveServer, startLiveServer } from "./live-server.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const INSTANCE = "cross-origin-e2e";

let srv: LiveServer;
let work: string;
let serve: ReturnType<typeof Bun.spawn> | undefined;
let APP: string;
let browser: Browser;

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ notes: defineTable({ body: v.string() }) });`,
    },
    {
      path: "notes.js",
      source: `import { mutation, query } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const add = mutation({ args: { body: v.string() }, handler: ({ db }, { body }) => db.insert("notes", { body }) });
        export const list = query({ args: {}, handler: ({ db }) => db.query("notes").collect() });`,
    },
  ]);
  // something for the metrics to count
  await srv.call("mutation", "notes:add", { body: "one" });
  await srv.call("query", "notes:list");
  work = mkdtempSync(join(tmpdir(), "bunvex-cross-origin-"));
  // the app as the release's dashboard.zip holds it, without the local dashboard's sign-in by itself
  const build = Bun.spawn(["bun", "--bun", "vite", "build", "--outDir", join(work, "app"), "--emptyOutDir"], {
    cwd: join(ROOT, "apps/dashboard"),
    // bun test sets NODE_ENV=test, which would give Vite (and React) a development build
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("the dashboard did not build");
  // served from a directory with no project: the sign-in page, as the image shows it
  mkdirSync(join(work, "elsewhere"));
  serve = Bun.spawn(
    ["bun", join(ROOT, "packages/cli/bin/bunvex.ts"), "dashboard", "serve", "--port", "0", "--dir", join(work, "app")],
    {
      cwd: join(work, "elsewhere"),
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, BUNVEX_DISABLE_VERSION_CHECK: "1" },
    },
  );
  const reader = (serve.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/Serving the dashboard at (http:\/\/127\.0\.0\.1:\d+)\//.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`bunvex dashboard serve exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  APP = /Serving the dashboard at (http:\/\/127\.0\.0\.1:\d+)\//.exec(text)![1]!;
  browser = await chromium.launch(process.env.E2E_BROWSER === "chromium" ? {} : { channel: "chrome" });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  serve?.kill();
  await serve?.exited;
  srv?.stop();
  if (work) rmSync(work, { recursive: true, force: true });
});

/** The value shown next to `label` in a `<dl>` (the header's and the Overview's). */
const shownValue = (page: Page, label: string) =>
  page.evaluate((label) => {
    const dt = [...document.querySelectorAll("dt")].find(
      (d) => d.textContent?.trim() === label && (d as HTMLElement).offsetParent !== null,
    );
    return dt?.nextElementSibling?.textContent?.trim() ?? null;
  }, label);

/** Waits until the value next to `label` is shown (no longer "…"); it. */
async function shown(page: Page, label: string): Promise<string> {
  await page.waitForFunction(
    (label) => {
      const dt = [...document.querySelectorAll("dt")].find(
        (d) => d.textContent?.trim() === label && (d as HTMLElement).offsetParent !== null,
      );
      const value = dt?.nextElementSibling?.textContent?.trim();
      return value !== undefined && value !== "…";
    },
    label,
    { timeout: 15_000 },
  );
  return (await shownValue(page, label))!;
}

describe("the dashboard on another origin than its deployment", () => {
  test("signed in: the header shows the deployment, the Overview's metrics and counters load", async () => {
    expect(new URL(APP).port).not.toBe(new URL(srv.url).port);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const failed: string[] = [];
    const asked: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // a CORS refusal is a failed request in the browser (net::ERR_FAILED), whatever the server answered
    page.on("requestfailed", (r) => {
      if (r.url().startsWith(srv.url) && r.failure()?.errorText !== "net::ERR_ABORTED")
        failed.push(`${r.method()} ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error" && /CORS|Access-Control/i.test(m.text())) failed.push(m.text());
    });
    page.on("request", (r) => {
      if (r.url().startsWith(srv.url) && r.headers()["bunvex-client"]) asked.push(new URL(r.url()).pathname);
    });

    await page.goto(`${APP}/`);
    await page.getByRole("heading", { level: 1, name: "Sign in to a deployment" }).waitFor();
    await page.getByLabel("Deployment URL", { exact: true }).fill(srv.url);
    await page.getByLabel("Admin key", { exact: true }).fill(srv.adminKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor();

    // the header: the deployment, not "Deployment unavailable"
    const version = await (await fetch(`${srv.url}/instance_version`)).text();
    expect(await shown(page, "Version")).toBe(version);
    expect(await shown(page, "Persistence")).toBe("memory");
    expect(await shown(page, "Deployment")).toBe(INSTANCE);
    expect(await page.getByText("Deployment unavailable").count()).toBe(0);

    // the Overview's metrics (`/api/app_metrics/*`): the calls counted, the charts drawn without an error
    await page.getByRole("heading", { name: "Metrics" }).scrollIntoViewIfNeeded();
    await page.getByRole("heading", { name: "Functions, last hour" }).waitFor({ timeout: 15_000 });
    await shown(page, "Calls per minute");
    // the live counters (`/stats`, polled); the open connections come from the topology (`/api/debug/topology`,
    // STUDY-131 §11), which a deployment offers, so the Overview shows them in place of the live subscriptions
    expect(await shown(page, "Live connections")).toMatch(/^\d/);
    await page.getByText("Engine", { exact: false }).first().click();
    await shown(page, "Commits per second");
    await page.getByRole("heading", { name: "Function calls" }).waitFor();
    expect(await page.getByText(/^Could not load/).count()).toBe(0);

    // every route the header and the Overview read was asked from the page's origin, and none failed
    expect(asked).toEqual(
      expect.arrayContaining(["/instance_name", "/instance_version", "/stats", "/api/debug/topology"]),
    );
    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);
});
