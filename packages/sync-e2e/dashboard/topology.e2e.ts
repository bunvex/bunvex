// The Topology screen on a live deployment, in Chromium (STUDY-131 §11, AD-04): the built app signs in to a bunvex
// server running in this process and draws its one node from `/api/debug/topology` — the leader alone, its query
// cache bounded by bytes, its memory store behind a file lock — and a client that connects and subscribes shows on
// it within a poll, then leaves it.
//
// Not a `*.test.ts`: it needs a browser and the app's build, so it runs with the dashboard's browser tests
// (`bun run e2e` at the root, CI's "e2e · dashboard in Chromium"): the system Chrome locally, Playwright's Chromium
// in CI (`E2E_BROWSER=chromium`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BunvexClient } from "@bunvex/client";
import { type Browser, chromium, type Page } from "playwright-core";
import { type LiveServer, startLiveServer } from "./live-server.ts";

const DIST = `${import.meta.dir}/../../../apps/dashboard/dist`;
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const INSTANCE = "dashboard-topology-e2e";

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
      path: "notes.js",
      source: `import { query } from "@bunvex/server";
        export const list = query(async ({ db }) => db.query("notes").collect());`,
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

/** The clients the summary counts ("Leader … · no followers · 2 clients · Memory OK"). */
const clientsIn = (summary: string) => Number(/ · ([\d,]+) clients? · /.exec(summary)?.[1]?.replace(/,/g, "") ?? NaN);

describe("Topology on a live deployment", () => {
  test("the deployment's one node and its store; a client that connects shows on it, and leaves", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${APP}/topology`);
    await heading(page, "Sign in to a deployment");
    await page.getByLabel("Deployment URL", { exact: true }).fill(srv.url);
    await page.getByLabel("Admin key", { exact: true }).fill(srv.adminKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await heading(page, "Topology");

    const summary = page.getByTestId("topology-summary");
    await summary.waitFor();
    const text = (await summary.textContent()) ?? "";
    // the node is this process (its lease holder: host, pid and a random suffix); the dashboard's own socket is a client
    expect(text).toMatch(/^Leader \S+:\d+:[0-9a-f]{8} · no followers · [\d,]+ clients? · Memory OK$/);
    const id = /^Leader (\S+) · /.exec(text)![1]!;
    const node = page.locator(`.react-flow__node[data-id="node:${id}"]`);
    await node.waitFor();
    expect(await node.getAttribute("aria-label")).toMatch(new RegExp(`^${id}, the only node, OK, `));
    // the cache strip: bounded by bytes, as the deployment's LRU is
    expect(await node.locator("[data-cache-strip]").textContent()).toMatch(/\/100 MB/);
    await page.getByText("One node: a file lock keeps a second one out").waitFor();
    await page.getByText(/followers appear when bunvex runs more than one/).waitFor();
    const before = clientsIn(text);

    // an app connects and subscribes: the node counts it within a poll (5 s)
    const client = new BunvexClient(srv.url, { logger: false });
    const off = client.onUpdate("notes:list", {}, () => {});
    try {
      await page.waitForFunction(
        ([n, re]) => {
          const t = document.querySelector('[data-testid="topology-summary"]')?.textContent ?? "";
          const m = new RegExp(re).exec(t);
          return m !== null && Number(m[1]!.replace(/,/g, "")) === n;
        },
        [before + 1, " · ([\\d,]+) clients? · "] as const,
        { timeout: 15_000 },
      );
      // the node's panel says it too
      await node.click();
      const panel = page.getByRole("complementary", { name: id });
      await panel.waitFor();
      await panel.getByText("Runs here").waitFor();
      expect(await panel.locator("dt", { hasText: "Connections" }).locator("+ dd").textContent()).toBe(
        String(before + 1),
      );
      await page.addScriptTag({ content: AXE });
      const violations = await page.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
        const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
        return r.violations.map((v: { id: string }) => v.id);
      });
      expect(violations).toEqual([]);
    } finally {
      off();
      await client.close();
    }
    // and leaves it
    await page.waitForFunction(
      ([n, re]) => {
        const t = document.querySelector('[data-testid="topology-summary"]')?.textContent ?? "";
        const m = new RegExp(re).exec(t);
        return m !== null && Number(m[1]!.replace(/,/g, "")) === n;
      },
      [before, " · ([\\d,]+) clients? · "] as const,
      { timeout: 15_000 },
    );
    expect(errors).toEqual([]);
    await context.close();
  });
});
