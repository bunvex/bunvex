// The local dashboard in Chromium (STUDY-149 PR 7): the app built as `dashboard.zip` is (with
// VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1), served by the real `bunvex dashboard serve` in a project whose deployment is
// local (here a bunvex server in this process), signs in by itself from `/api/current_deployment`, as Convex's
// local dashboard does — at 127.0.0.1 and at localhost. Opened under another name that resolves to 127.0.0.1 (a
// DNS-rebinding page), the server refuses the credentials (the `Host` check, DV-476) and the sign-in page is shown.
// The frame and security headers of Convex's image (STUDY-149 PR 7 follow-up) leave that working, keep the
// dashboard out of another site's frame, and let a parent the build allows (DV-319) frame it and sign it in
// (DV-488; with Convex's COEP of an embedding build).
//
// Not a `*.test.ts`: it needs a browser and builds the app, so it runs with the dashboard's browser tests (`bun run
// e2e`, CI's "e2e · dashboard in Chromium"): the system Chrome locally, Playwright's Chromium in CI
// (`E2E_BROWSER=chromium`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { type LiveServer, startLiveServer } from "./live-server.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const INSTANCE = "local-dashboard-e2e";
const REBOUND = "rebound.example";

let srv: LiveServer;
let work: string;
const serves: ReturnType<typeof Bun.spawn>[] = [];
let PORT: string;
let EMBED_PORT: string;
let parent: ReturnType<typeof Bun.serve>;
let browser: Browser;

/** `bunvex dashboard serve --dir <dir>` from `cwd`, until the tests end; its port. */
async function dashboardServe(dir: string, cwd: string): Promise<string> {
  const serve = Bun.spawn(
    ["bun", join(ROOT, "packages/cli/bin/bunvex.ts"), "dashboard", "serve", "--port", "0", "--dir", dir],
    { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, BUNVEX_DISABLE_VERSION_CHECK: "1" } },
  );
  serves.push(serve);
  const reader = (serve.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/Serving the dashboard at http:\/\/127\.0\.0\.1:(\d+)\//.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`bunvex dashboard serve exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  return /127\.0\.0\.1:(\d+)/.exec(text)![1]!;
}

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
  PORT = await dashboardServe(join(work, "app"), project);
  // a page of another site that frames the dashboard and, when asked, hands it the deployment's credentials
  parent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const port = new URL(req.url).searchParams.get("dashboard");
      const credentials = {
        type: "dashboard-credentials",
        adminKey: srv.adminKey,
        deploymentUrl: srv.url,
        deploymentName: INSTANCE,
      };
      return new Response(
        `<!doctype html><iframe src="http://127.0.0.1:${port}/" style="width:1400px;height:900px"></iframe><script>
          addEventListener("message", (e) => {
            if (e.data && e.data.type === "dashboard-credentials-request") e.source.postMessage(${JSON.stringify(credentials)}, e.origin);
          });</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  // the same build, allowing that page at localhost (not at 127.0.0.1) to embed it, served outside the project
  cpSync(join(work, "app"), join(work, "embedded"), { recursive: true });
  const index = join(work, "embedded/index.html");
  writeFileSync(
    index,
    readFileSync(index, "utf8").replace(
      '<meta name="bunvex-embed-origins" content="">',
      `<meta name="bunvex-embed-origins" content="http://localhost:${parent.port}">`,
    ),
  );
  if (!readFileSync(index, "utf8").includes(`localhost:${parent.port}`)) throw new Error("no embed-origins tag");
  mkdirSync(join(work, "elsewhere"));
  EMBED_PORT = await dashboardServe(join(work, "embedded"), join(work, "elsewhere"));
  browser = await chromium.launch({
    ...(process.env.E2E_BROWSER === "chromium" ? {} : { channel: "chrome" }),
    // a name of the attacker's that now resolves to this machine
    args: [`--host-resolver-rules=MAP ${REBOUND} 127.0.0.1`],
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  for (const serve of serves) serve.kill();
  await Promise.all(serves.map((serve) => serve.exited));
  parent?.stop(true);
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
  const response = await page.goto(`http://${host}:${PORT}/`);
  return { page, errors, answers, headers: response!.headers(), close: () => context.close() };
}

describe("bunvex dashboard serve, the local dashboard", () => {
  for (const host of ["127.0.0.1", "localhost"])
    test(`at ${host}: signed in by itself to the project's deployment`, async () => {
      const { page, errors, answers, headers, close } = await open(host);
      // Convex's image headers, framing same-origin only
      expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(headers["content-security-policy"]).toBe("frame-ancestors 'self'");
      expect(headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains; preload");
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

/**
 * A page of `parentHost` framing the dashboard on `port`: the dashboard's frame, and Chrome's report of a refused
 * one (the frame's document fails with `ERR_BLOCKED_BY_RESPONSE`, the console names the policy) and whether the
 * dashboard's scripts were fetched (never, for a refused frame).
 */
async function framed(parentHost: string, port: string) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  const scripts: string[] = [];
  const blocked: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => {
    if (r.url() === `http://127.0.0.1:${port}/`) blocked.push(r.failure()?.errorText ?? "");
  });
  page.on("console", (m) => logs.push(m.text()));
  page.on("request", (r) => {
    if (r.url().startsWith(`http://127.0.0.1:${port}/assets/`)) scripts.push(r.url());
  });
  await page.goto(`http://${parentHost}:${parent.port}/?dashboard=${port}`);
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!;
  const refused = async () => {
    const report = () => logs.find((m) => m.startsWith(`Framing 'http://127.0.0.1:${port}/' violates`));
    for (let i = 0; i < 200 && !(report() && blocked.length); i++) await Bun.sleep(25);
    return { blocked, report: report() ?? "" };
  };
  return { page, frame, errors, scripts, refused, close: () => context.close() };
}

describe("bunvex dashboard serve, framed by another site", () => {
  test("a build that allows no parent: Chrome refuses the frame (frame-ancestors 'self', X-Frame-Options)", async () => {
    const { refused, scripts, close } = await framed("localhost", PORT);
    const { blocked, report } = await refused();
    expect(blocked).toEqual(["net::ERR_BLOCKED_BY_RESPONSE"]);
    expect(report).toContain(`directive: "frame-ancestors 'self'"`);
    expect(scripts).toEqual([]);
    await close();
  });

  test("a build that allows the parent (DV-319): framed and signed in by it; another origin refused (DV-488)", async () => {
    const allowed = await framed("localhost", EMBED_PORT);
    await allowed.frame().getByRole("heading", { level: 1, name: "Overview" }).waitFor();
    await allowed
      .frame()
      .getByRole("button", { name: `Signed in: ${INSTANCE}` })
      .waitFor();
    expect(allowed.frame().url()).toBe(`http://127.0.0.1:${EMBED_PORT}/`);
    expect(allowed.errors).toEqual([]);
    await allowed.close();
    // the same page at 127.0.0.1 is another origin, not in the list: frame-ancestors keeps it out
    const other = await framed("127.0.0.1", EMBED_PORT);
    const { blocked, report } = await other.refused();
    expect(blocked).toEqual(["net::ERR_BLOCKED_BY_RESPONSE"]);
    expect(report).toContain(`directive: "frame-ancestors 'self' http://localhost:${parent.port}"`);
    expect(other.scripts).toEqual([]);
    await other.close();
  });
});
