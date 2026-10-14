// The local dashboard in Chromium (STUDY-149 PR 7): the app built as `dashboard.zip` is (with
// VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1), served by the real `bunvex dashboard serve` in a project whose deployment is
// local (here a bunvex server in this process), signs in by itself from `/api/current_deployment`, as Convex's
// local dashboard does — at 127.0.0.1 and at localhost. Opened under another name that resolves to 127.0.0.1 (a
// DNS-rebinding page), the server refuses the credentials (the `Host` check, DV-476) and the sign-in page is shown.
//
// Not a `*.test.ts`: it needs a browser and builds the app, so it runs with the dashboard's browser tests (`bun run
// e2e`, CI's "e2e · dashboard in Chromium"): the system Chrome locally, Playwright's Chromium in CI
// (`E2E_BROWSER=chromium`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { type LiveServer, startLiveServer } from "./live-server.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const INSTANCE = "local-dashboard-e2e";
const REBOUND = "rebound.example";

let srv: LiveServer;
let work: string;
let serve: ReturnType<typeof Bun.spawn>;
let PORT: string;
let browser: Browser;

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ notes: defineTable({ body: v.string() }) });`,
    },
  ]);
  work = mkdtempSync(join(tmpdir(), "bunvex-local-dashboard-"));
  // the app as the release's dashboard.zip holds it
  const build = Bun.spawn(["bun", "--bun", "vite", "build", "--outDir", join(work, "app"), "--emptyOutDir"], {
    cwd: join(ROOT, "apps/dashboard"),
    // bun test sets NODE_ENV=test, which would give Vite (and React) a development build
    env: { ...process.env, NODE_ENV: "production", VITE_BUNVEX_USE_CURRENT_DEPLOYMENT: "1" },
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("the dashboard did not build");
  // a project whose deployment is local: the server above
  const project = join(work, "project");
  mkdirSync(join(project, ".bunvex/local/default"), { recursive: true });
  writeFileSync(join(project, ".env.local"), `BUNVEX_DEPLOYMENT=local:${INSTANCE}\n`);
  writeFileSync(
    join(project, ".bunvex/local/default/config.json"),
    JSON.stringify({
      ports: { cloud: Number(new URL(srv.url).port), site: 0 },
      backendVersion: "e2e",
      adminKey: srv.adminKey,
      instanceSecret: "00",
      deploymentName: INSTANCE,
    }),
  );
  serve = Bun.spawn(
    ["bun", join(ROOT, "packages/cli/bin/bunvex.ts"), "dashboard", "serve", "--port", "0", "--dir", join(work, "app")],
    { cwd: project, stdout: "ignore", stderr: "pipe", env: { ...process.env, BUNVEX_DISABLE_VERSION_CHECK: "1" } },
  );
  const reader = (serve.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/Serving the dashboard at http:\/\/127\.0\.0\.1:(\d+)\//.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`bunvex dashboard serve exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  PORT = /127\.0\.0\.1:(\d+)/.exec(text)![1]!;
  browser = await chromium.launch({
    ...(process.env.E2E_BROWSER === "chromium" ? {} : { channel: "chrome" }),
    // a name of the attacker's that now resolves to this machine
    args: [`--host-resolver-rules=MAP ${REBOUND} 127.0.0.1`],
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  serve?.kill();
  await serve?.exited;
  srv?.stop();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function open(host: string) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const answers: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/current_deployment")) answers.push(r.status());
  });
  await page.goto(`http://${host}:${PORT}/`);
  return { page, errors, answers, close: () => context.close() };
}

describe("bunvex dashboard serve, the local dashboard", () => {
  for (const host of ["127.0.0.1", "localhost"])
    test(`at ${host}: signed in by itself to the project's deployment`, async () => {
      const { page, errors, answers, close } = await open(host);
      await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
      await page.getByRole("button", { name: `Signed in: ${INSTANCE}` }).waitFor();
      expect(answers).toEqual([200]);
      expect(await page.getByRole("heading", { name: "Sign in to a deployment" }).count()).toBe(0);
      expect(errors).toEqual([]);
      await close();
    });

  test("at a rebound name: the credentials refused (403), the sign-in page shown", async () => {
    const { page, errors, answers, close } = await open(REBOUND);
    await page.getByRole("heading", { level: 1, name: "Sign in to a deployment" }).waitFor();
    expect(answers).toEqual([403]);
    // the page's own script cannot read them either
    const body = await page.evaluate(async () => (await fetch("/api/current_deployment")).text());
    expect(body).not.toContain(srv.adminKey);
    expect(errors).toEqual([]);
    await close();
  });
});
