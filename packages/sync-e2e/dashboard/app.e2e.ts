// The dashboard app on a live deployment, in Chromium (STUDY-149 PR 6): the built app (apps/dashboard/dist) signs
// in to a bunvex server running in this process, through a proxy this test can take down, and its screens run on
// @bunvex/dashboard-source — the sign-in (Convex's `check_admin_key`, the client header), Data read live and
// written, Functions and the runner (a query subscribed, a mutation, the custom test query), Logs live, the
// environment variables both ways, a table created by a push appearing by itself, and the connection lost and
// recovered (Convex's "Connection issue" and the live reads resuming).
//
// Not a `*.test.ts`: it needs a browser and the app's build, so it runs with the dashboard's browser tests
// (`bun run e2e` at the root, CI's "e2e · dashboard in Chromium"): the system Chrome locally, Playwright's Chromium
// in CI (`E2E_BROWSER=chromium`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Browser, chromium, type Page } from "playwright-core";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const DIST = `${import.meta.dir}/../../../apps/dashboard/dist`;
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const INSTANCE = "dashboard-app-e2e";

const SCHEMA = {
  path: "schema.js",
  source: `import { defineSchema, defineTable } from "@bunvex/server";
    import { v } from "@bunvex/values";
    export default defineSchema({ messages: defineTable({ body: v.string() }) });`,
};
const MODULES = [
  SCHEMA,
  {
    path: "messages.js",
    source: `import { action, mutation, query } from "@bunvex/server";
      import { v } from "@bunvex/values";
      export const send = mutation({ args: { body: v.string() }, handler: async ({ db }, { body }) => {
        console.info("sending", body);
        await db.insert("messages", { body });
        return body.length;
      } });
      export const list = query({ args: {}, handler: async ({ db }) =>
        (await db.query("messages").collect()).map((m) => m.body) });
      export const shout = action({ args: {}, handler: async () => { console.warn("shouting"); return "HI"; } });`,
  },
  {
    path: "bulk.js",
    source: `import { mutation, query } from "@bunvex/server";
      import { v } from "@bunvex/values";
      export const seed = mutation({ args: { n: v.number() }, handler: async ({ db }, { n }) => {
        for (let i = 0; i < n; i++) await db.insert("bulk", { i, note: "x" });
      } });
      export const all = query({ args: {}, handler: async ({ db }) => await db.query("bulk").collect() });`,
  },
  {
    path: "http.js",
    source: `import { httpAction, httpRouter } from "@bunvex/server";
      const http = httpRouter();
      http.route({ path: "/hello", method: "GET", handler: httpAction(async () => new Response("hi")) });
      export default http;`,
  },
];

/**
 * An HTTP and WebSocket proxy in front of the server, which the test takes down (every connection dropped, new
 * ones refused) and brings back on the same port: the browser sees the deployment go away and return.
 */
function startProxy(target: string) {
  const sockets = new Set<WebSocket>();
  let server: ReturnType<typeof Bun.serve<{ path: string; upstream?: WebSocket; queue: (string | Buffer)[] }>>;
  const listen = (port: number) =>
    Bun.serve<{ path: string; upstream?: WebSocket; queue: (string | Buffer)[] }>({
      hostname: "127.0.0.1",
      port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (req.headers.get("upgrade") === "websocket") {
          if (srv.upgrade(req, { data: { path: url.pathname + url.search, queue: [] } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        const headers = new Headers(req.headers);
        headers.delete("host");
        const res = await fetch(`${target}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          ...(req.method !== "GET" && req.method !== "HEAD" && { body: await req.arrayBuffer() }),
          signal: req.signal,
        });
        const out = new Headers(res.headers);
        out.delete("content-encoding");
        out.delete("content-length");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
      },
      websocket: {
        open(ws) {
          const up = new WebSocket(`${target.replace(/^http/, "ws")}${ws.data.path}`);
          ws.data.upstream = up;
          sockets.add(up);
          up.binaryType = "arraybuffer";
          up.onopen = () => {
            for (const m of ws.data.queue.splice(0)) up.send(m);
          };
          up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
          up.onclose = () => {
            sockets.delete(up);
            ws.close();
          };
        },
        message(ws, m) {
          const up = ws.data.upstream;
          if (up?.readyState === WebSocket.OPEN) up.send(m);
          else ws.data.queue.push(m);
        },
        close(ws) {
          ws.data.upstream?.close();
        },
      },
    });
  server = listen(0);
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    down() {
      server.stop(true);
      for (const s of sockets) s.close();
      sockets.clear();
    },
    up() {
      server = listen(port);
    },
    stop() {
      server.stop(true);
      for (const s of sockets) s.close();
    },
  };
}

let srv: LiveServer;
let proxy: ReturnType<typeof startProxy>;
let app: ReturnType<typeof Bun.serve>;
let browser: Browser;
let APP: string;

beforeAll(async () => {
  if (!existsSync(`${DIST}/index.html`))
    throw new Error("build the dashboard first: bun run --cwd apps/dashboard build");
  srv = await startLiveServer(INSTANCE, MODULES);
  await srv.call("mutation", "messages:send", { body: "first" });
  proxy = startProxy(srv.url);
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
  proxy?.stop();
  srv?.stop();
});

const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name }).waitFor();
const cellOf = (page: Page, text: RegExp) => page.getByRole("gridcell").filter({ hasText: text }).first();

/** A fresh tab on `path`, signed out; records uncaught errors and the requests sent to the deployment. */
async function fresh(path = "/") {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const toDeployment: { url: string; headers: Record<string, string> }[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    if (r.url().startsWith(proxy.url)) toDeployment.push({ url: r.url(), headers: r.headers() });
  });
  await page.goto(`${APP}${path}`);
  await heading(page, "Sign in to a deployment");
  return { page, errors, toDeployment, close: () => context.close() };
}

async function signIn(page: Page, adminKey = srv.adminKey) {
  await page.getByLabel("Deployment URL", { exact: true }).fill(proxy.url);
  await page.getByLabel("Admin key", { exact: true }).fill(adminKey);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Signed in on `path` (the address it was opened at is the screen it opens on). */
async function signedIn(path: string, adminKey = srv.adminKey) {
  const tab = await fresh(path);
  await signIn(tab.page, adminKey);
  return tab;
}

/** Empties the focused Monaco editor and types `text`. */
async function typeInEditor(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

const messages = async () => (await srv.call("query", "messages:list")) as string[];

const envVars = async () => {
  const res = await fetch(`${srv.url}/api/v1/list_environment_variables`, {
    headers: { Authorization: `Bunvex ${srv.adminKey}` },
  });
  return ((await res.json()) as { environmentVariables: Record<string, string> }).environmentVariables;
};

describe("the dashboard app on a live deployment", () => {
  test("sign-in: a wrong key is refused; the deployment's key opens its screens; Bunvex auth and client header; sign out", async () => {
    const { page, errors, toDeployment, close } = await fresh("/");
    await signIn(page, `${INSTANCE}|00`);
    await page.getByRole("alert").filter({ hasText: "The deployment URL or admin key is invalid" }).waitFor();
    await signIn(page);
    await heading(page, "Overview");
    // the deployment's own name and version, from the server
    await page.getByRole("button", { name: `Signed in: ${INSTANCE}` }).waitFor();
    // (the header's visible line: the phone's one-line summary is hidden at this width)
    await page.getByText(INSTANCE, { exact: true }).filter({ visible: true }).first().waitFor();
    expect(await page.getByText("Deployment unavailable").count()).toBe(0);
    // as Convex's dashboard: the admin key in Authorization (bunvex's scheme, DV-97) and the client header
    const checks = toDeployment.filter((r) => r.url.endsWith("/api/check_admin_key") && r.headers.authorization);
    expect(checks.map((r) => r.headers.authorization)).toContain(`Bunvex ${srv.adminKey}`);
    expect(checks.every((r) => /^dashboard-\d+\.\d+\.\d+$/.test(r.headers["bunvex-client"] ?? ""))).toBe(true);
    await page.getByRole("button", { name: `Signed in: ${INSTANCE}` }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await heading(page, "Sign in to a deployment");
    // like Convex, the key is not kept: a reload asks again
    await page.reload();
    await heading(page, "Sign in to a deployment");
    expect(errors).toEqual([]);
    await close();
  });

  test("a read-only key: the Data screen opens read-only", async () => {
    const { page, errors, close } = await signedIn("/database/messages", srv.readOnlyKey);
    await heading(page, "messages");
    await page.getByText("Read-only").first().waitFor();
    expect(errors).toEqual([]);
    await close();
  });

  test("Data: the documents, live; a cell edited and a document added reach the deployment", async () => {
    const { page, errors, close } = await signedIn("/database/messages");
    await heading(page, "messages");
    await cellOf(page, /^first$/).waitFor();
    // written by the app: shown without a reload (the page's subscription)
    await srv.call("mutation", "messages:send", { body: "from the app" });
    await cellOf(page, /^from the app$/).waitFor();
    // a cell: Enter edits, Enter saves (patchDocumentsFields over the socket)
    await cellOf(page, /^first$/).click();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await typeInEditor(page, '"edited"');
    await page.keyboard.press("Enter");
    await cellOf(page, /^edited$/).waitFor();
    await until(async () => (await messages()).includes("edited"), "the edit on the deployment");
    // Add documents (addDocument)
    await page.getByRole("button", { name: "Add documents" }).click();
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await typeInEditor(page, '{ body: "added" }');
    await page.getByRole("button", { name: "Add document", exact: true }).click();
    await cellOf(page, /^added$/).waitFor();
    await until(async () => (await messages()).includes("added"), "the insert on the deployment");
    expect(errors).toEqual([]);
    await close();
  });

  test("Data: bulk edit — the header selects every document of a table still paging; Edit all patches them all", async () => {
    // more documents than the screen's first page (100), so "all" covers documents never loaded
    await srv.call("mutation", "bulk:seed", { n: 150 });
    const { page, errors, close } = await signedIn("/database/bulk");
    await heading(page, "bulk");
    await page.getByRole("checkbox", { name: "Select all documents" }).click();
    await page.getByRole("button", { name: "Edit all" }).click();
    const panel = page.getByRole("complementary", { name: "Bulk edit all documents in bulk" });
    await panel.waitFor();
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await typeInEditor(page, "{ checked: true, note: undefined }");
    await panel.getByRole("button", { name: "Apply" }).click();
    await page.getByText("Edited all documents in bulk.").waitFor();
    // on the deployment: every document, in one patchDocumentsFields without ids
    await until(async () => {
      const docs = (await srv.call("query", "bulk:all")) as Record<string, unknown>[];
      return docs.length === 150 && docs.every((d) => d.checked === true && !("note" in d));
    }, "the bulk edit on the deployment");
    // the schema's refusal, in the deployment's words; nothing written
    await page.getByRole("navigation", { name: "Tables" }).getByRole("link", { name: "messages" }).click();
    await heading(page, "messages");
    await page.getByRole("checkbox", { name: "Select all documents" }).click();
    await page.getByRole("button", { name: "Edit all" }).click();
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await typeInEditor(page, "{ body: 1 }");
    const messagesPanel = page.getByRole("complementary", { name: "Bulk edit all documents in messages" });
    await messagesPanel.getByRole("button", { name: "Apply" }).click();
    await messagesPanel.getByRole("alert").filter({ hasText: "does not match the schema" }).waitFor();
    expect((await messages()).every((b) => typeof b === "string")).toBe(true);
    // axe on the open panel
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: axe is the injected global
      const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v: { id: string }) => v.id);
    });
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
    await close();
  });

  test("Data: a table a push creates appears in the list by itself (the table mapping, live)", async () => {
    const { page, errors, close } = await signedIn("/database/messages");
    await heading(page, "messages");
    const sidebar = page.getByRole("navigation", { name: "Tables" });
    expect(await sidebar.getByRole("link", { name: "notes" }).count()).toBe(0);
    await srv.push([
      {
        ...SCHEMA,
        source: SCHEMA.source.replace(
          "messages: defineTable({ body: v.string() })",
          "messages: defineTable({ body: v.string() }), notes: defineTable({ text: v.string() })",
        ),
      },
      ...MODULES.slice(1),
    ]);
    await sidebar.getByRole("link", { name: "notes" }).waitFor();
    expect(errors).toEqual([]);
    await close();
  });

  test("Data: the system tables (AD-24) are listed, and one opens with its documents, read-only", async () => {
    const { page, errors, close } = await signedIn("/database/messages");
    await heading(page, "messages");
    await page.getByRole("checkbox", { name: "Show system tables" }).click();
    const list = page.getByRole("list", { name: "System tables" });
    // the deployment's catalog, private tables included, and the one apps read as `_storage`
    for (const name of ["_tables", "_index", "_file_storage"])
      await list.getByRole("link", { name: new RegExp(`^${name}\\b`) }).waitFor();
    await list.getByRole("link", { name: /^_tables\b/ }).click();
    await heading(page, "_tables");
    await page.getByText("Private system table").waitFor();
    await page.getByText(/^Every table: its name, number and state/).waitFor();
    // `_tables`' documents as stored, oldest first: the bootstrap tables' rows, their numbers int64s
    const grid = page.getByRole("table", { name: "Documents in _tables" });
    await grid
      .getByText(/^_index$/)
      .first()
      .waitFor();
    await grid
      .getByText(/^514n$/)
      .first()
      .waitFor();
    // newest first: the app's table, created by its push, comes near the top
    await page.getByRole("button", { name: "Oldest first" }).click();
    await page.getByRole("button", { name: "Newest first" }).waitFor();
    await grid
      .getByText(/^messages$/)
      .first()
      .waitFor();
    expect(await page.getByRole("button", { name: /Add documents/ }).count()).toBe(0);
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
      const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
    await close();
  });

  test("Functions and the runner: a query subscribed, a mutation run, the custom test query", async () => {
    const { page, errors, close } = await signedIn("/functions?function=messages:list");
    await page.getByRole("heading", { level: 1, name: "list" }).waitFor();
    // the app's HTTP routes are in the tree, under http, as Convex lists them; not runnable
    await page.getByRole("link", { name: /GET \/hello/ }).click();
    await page.getByRole("heading", { level: 1, name: "GET /hello" }).waitFor();
    expect(await page.getByRole("button", { name: "Run", exact: true }).count()).toBe(0);
    await page
      .getByRole("link", { name: /^list\b/ })
      .first()
      .click();
    await page.getByRole("heading", { level: 1, name: "list" }).waitFor();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const runner = page.getByRole("region", { name: "Run a function" });
    await runner.getByText(/^Subscribed: the result updates/).waitFor();
    await runner
      .getByText(/"edited"|"first"/)
      .first()
      .waitFor();
    // the query follows the data
    await srv.call("mutation", "messages:send", { body: "seen by the runner" });
    await runner
      .getByText(/seen by the runner/)
      .first()
      .waitFor();
    // a mutation, with its arguments typed
    await runner.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /messages:send/ }).click();
    await runner.getByRole("textbox", { name: "Arguments" }).focus();
    await typeInEditor(page, '{ body: "from the runner" }');
    await runner.getByRole("button", { name: "Run mutation" }).click();
    await runner.getByText(/^Succeeded in/).waitFor();
    await until(async () => (await messages()).includes("from the runner"), "the runner's mutation");
    // the custom test query: only on a deployment (`/api/run_test_function`), first in the picker as Convex's
    await runner.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Custom test query" }).click();
    await runner.getByRole("textbox", { name: "Test query" }).focus();
    await typeInEditor(
      page,
      'export default query({ handler: async (ctx) => { console.log("testing"); return (await ctx.db.query("messages").collect()).length; } });',
    );
    await runner.getByRole("button", { name: "Run test query" }).click();
    await runner.getByText(/^Succeeded in/).waitFor();
    await runner.getByText("testing").first().waitFor();
    expect(errors).toEqual([]);
    await close();
  });

  test("Logs: an execution's line arrives live (the long poll)", async () => {
    const { page, errors, close } = await signedIn("/logs");
    await heading(page, "Logs");
    const grid = page.getByRole("grid", { name: "Log lines" });
    await srv.call("mutation", "messages:send", { body: "for the logs" });
    await grid
      .getByText(/sending.*for the logs/)
      .first()
      .waitFor({ timeout: 15_000 });
    await srv.call("action", "messages:shout");
    await grid.getByText("shouting").first().waitFor({ timeout: 15_000 });
    expect(errors).toEqual([]);
    await close();
  });

  test("Settings: a variable saved reaches the deployment; one changed elsewhere shows by itself", async () => {
    const { page, errors, close } = await signedIn("/settings/environment-variables");
    await heading(page, "Environment variables");
    await page.getByRole("button", { name: "Add a variable" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("E2E_FLAG");
    await page.getByRole("textbox", { name: "Value" }).fill("yes");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved 1 change.").waitFor();
    await until(async () => (await envVars()).E2E_FLAG === "yes", "the variable on the deployment");
    // set by the CLI's route: the list follows (listEnvironmentVariables, subscribed)
    const res = await fetch(`${srv.url}/api/update_environment_variables`, {
      method: "POST",
      headers: { Authorization: `Bunvex ${srv.adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: [{ name: "FROM_THE_CLI", value: "1" }] }),
    });
    expect(res.status).toBe(200);
    await page.getByRole("listitem").filter({ hasText: "FROM_THE_CLI" }).waitFor();
    expect(errors).toEqual([]);
    await close();
  });

  test("the connection lost: Connection issue covers the screens; back: it goes and the live data resumes", async () => {
    const { page, errors, close } = await signedIn("/database/messages");
    await heading(page, "messages");
    await cellOf(page, /^from the app$/).waitFor();
    proxy.down();
    // Convex's watcher: the socket down at two checks 2.5 s apart
    const issue = page.getByRole("alert").filter({ hasText: "Connection issue" });
    await issue.waitFor({ timeout: 15_000 });
    await issue.getByText(proxy.url).waitFor();
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
      const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    // written while the dashboard cannot see it
    await srv.call("mutation", "messages:send", { body: "while away" });
    proxy.up();
    await issue.waitFor({ state: "detached", timeout: 30_000 });
    await cellOf(page, /^while away$/).waitFor({ timeout: 15_000 });
    // and live again
    await srv.call("mutation", "messages:send", { body: "after the return" });
    await cellOf(page, /^after the return$/).waitFor();
    expect(errors).toEqual([]);
    await close();
  });
});
