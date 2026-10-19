// The Rooms screens on a live deployment, in Chromium (AD-43, STUDY-165 §5.1): the built app signs in to a bunvex
// server running in this process, whose pushed code defines a room and a presence scope. No room is open at first;
// a client that joins and says its presence shows on the Rooms screen within a poll, with its member; the
// definitions show on the Functions screen; the Overview's Rooms section counts the join; and when the client
// leaves, the open room's panel says it closed, with no error.
//
// Not a `*.test.ts`: it needs a browser and the app's build, so it runs with the dashboard's browser tests
// (`bun run e2e` at the root, CI's "e2e · dashboard in Chromium"): the system Chrome locally, Playwright's Chromium
// in CI (`E2E_BROWSER=chromium`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { anyApi, BunvexClient } from "@bunvex/client";
import { type Browser, chromium, type Page } from "playwright-core";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const DIST = `${import.meta.dir}/../../../apps/dashboard/dist`;
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const INSTANCE = "dashboard-rooms-e2e";

let srv: LiveServer;
let app: ReturnType<typeof Bun.serve>;
let browser: Browser;
let APP: string;

beforeAll(async () => {
  if (!existsSync(`${DIST}/index.html`))
    throw new Error("build the dashboard first: bun run --cwd apps/dashboard build");
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ notes: defineTable({ body: v.string() }) });`,
    },
    {
      path: "rooms.js",
      source: `import { presence, room } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const doc = room({
          args: { id: v.string() },
          presence: v.object({ x: v.number() }),
          events: { wave: v.object({ hand: v.string() }) },
        });
        export const online = presence({ args: { team: v.string() }, state: v.any() });`,
    },
  ]);
  // the built app, as a static host serves it (index.html for every other path)
  app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (!path.includes("..") && path !== "/") {
        const file = Bun.file(`${DIST}${path}`);
        if (await file.exists()) return new Response(file);
      }
      return new Response(Bun.file(`${DIST}/index.html`), { headers: { "content-type": "text/html" } });
    },
  });
  APP = `http://127.0.0.1:${app.port}`;
  browser = await chromium.launch(process.env.E2E_BROWSER === "chromium" ? {} : { channel: "chrome" });
});

afterAll(async () => {
  await browser?.close();
  await app?.stop(true);
  srv?.stop();
});

const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name }).waitFor();
const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name, exact: true }).click();
const axeViolations = async (page: Page) => {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
    const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
    return r.violations.map((v: { id: string }) => v.id);
  });
};

describe("Rooms on a live deployment", () => {
  test("a room a client joins shows with its member, its definition and counters; it closes when the client leaves", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${APP}/rooms`);
    await heading(page, "Sign in to a deployment");
    await page.getByLabel("Deployment URL", { exact: true }).fill(srv.url);
    await page.getByLabel("Admin key", { exact: true }).fill(srv.adminKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await heading(page, "Rooms");
    await page.getByText("No room or presence scope is open.").waitFor();

    const client = new BunvexClient(srv.url, { logger: false });
    const handle = client.client.joinRoom<{ id: string }, unknown, { x: number }>(anyApi.rooms.doc as never, {
      id: "standup",
    });
    try {
      await until(() => handle.status === "joined", "the client joined");
      handle.setPresence({ x: 42 });
      // within a poll (1 s)
      const summary = page.getByTestId("rooms-summary");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="rooms-summary"]')?.textContent?.startsWith("1 open (1 room,"),
        undefined,
        { timeout: 5_000 },
      );
      expect(await summary.textContent()).toBe("1 open (1 room, 0 presence scopes) · 1 member · 1 connection");
      const row = page.getByRole("gridcell").filter({ hasText: /^rooms:doc$/ });
      await page.getByRole("gridcell").filter({ hasText: '{ id: "standup" }' }).waitFor();
      await row.click();
      const panel = page.getByRole("complementary", { name: "rooms:doc" });
      const member = panel.getByRole("region", { name: "Members" }).getByRole("listitem");
      await member.getByText("{ x: 42 }").waitFor({ timeout: 5_000 });
      // the client did not sign in
      await member.getByText("Signed out").waitFor();
      expect(await axeViolations(page)).toEqual([]);

      // the definitions, beside the functions
      // (in the app: a reload would sign out, as the admin key is kept in memory only)
      await page.keyboard.press("Escape");
      await nav(page, "Functions");
      const definitions = page.getByRole("navigation", { name: "Rooms and presence" });
      await definitions.getByRole("link", { name: /^rooms:doc/ }).click();
      await heading(page, "rooms:doc");
      expect(await page.getByRole("region", { name: "Arguments validator" }).textContent()).toContain("id: v.string()");
      await page.getByRole("region", { name: "Events" }).getByText("wave").waitFor();
      await definitions.getByRole("link", { name: /^rooms:online/ }).waitFor();

      // the counters, on the Overview
      await nav(page, "Overview");
      await heading(page, "Overview");
      await page.getByText(/— 1 open, 1 members, 1 connections/).click({ timeout: 10_000 });
      const counters = page.getByRole("region", { name: "Rooms now, and counters since the server started" });
      await counters.waitFor();
      expect(
        await counters
          .locator("dt", { hasText: /^Joins$/ })
          .locator("+ dd")
          .textContent(),
      ).toBe("1");
      expect(await axeViolations(page)).toEqual([]);

      // back on the room, it closes when its last member leaves
      await nav(page, "Rooms");
      await page
        .getByRole("gridcell")
        .filter({ hasText: /^rooms:doc$/ })
        .click();
      await page.getByRole("complementary", { name: "rooms:doc" }).getByText("{ x: 42 }").waitFor();
      handle.leave();
      const closed = page.getByRole("complementary", { name: "rooms:doc" }).getByRole("status");
      await closed.waitFor({ timeout: 5_000 });
      expect(await closed.textContent()).toContain("Closed");
      expect(await page.getByRole("alert").count()).toBe(0);
      await page.getByText("No room or presence scope is open.").waitFor();
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
    await context.close();
  });
});
