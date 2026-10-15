// The CLI's dashboard links (STUDY-149 PR 8, DV-477): where Convex's CLI links its cloud dashboard, bunvex links the
// local dashboard while `bunvex dev` serves it for this deployment, and prints no link otherwise (a self-hosted
// deployment never has one). `bunvex dev`'s own line and export through a real local dashboard are in
// dashboard-serve.test.ts; the MCP `status` tool's `dashboardUrl` in mcp.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { localDashboardLink, NO_DASHBOARD, servedDashboard } from "../src/dashboard-links.ts";
import { waitMessage } from "../src/deploy.ts";
import { exportCommand } from "../src/export.ts";
import { importCommand } from "../src/import.ts";
import { type Io, main } from "../src/index.ts";
import { type IndexConfig, printIndexDiff } from "../src/index-checks.ts";
import { stateDir } from "../src/local-deployment.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "5e".repeat(32);
const NAME = "links-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-links-"));
  dirs.push(d);
  return d;
};

function io(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env, cwd, out: (l) => out.push(l), err: (l) => err.push(l), prompt: () => "y" };
  return { it, out, err };
}

/** A project whose deployment is local, at `cloud`, named `name` (its config.json and `.env.local`). */
function localProject(cloud: number, name = NAME) {
  const dir = tmp();
  writeFileSync(join(dir, ".env.local"), `BUNVEX_DEPLOYMENT=local:${name}\n`);
  mkdirSync(stateDir(dir), { recursive: true });
  writeFileSync(
    join(stateDir(dir), "config.json"),
    JSON.stringify({
      ports: { cloud, site: cloud + 1 },
      backendVersion: "test",
      adminKey: KEY,
      instanceSecret: SECRET,
      deploymentName: name,
    }),
  );
  return dir;
}

/** A stand-in for `dev`'s local dashboard serving `name`, its port saved in `dir` as `dev` saves it. */
function localDashboard(dir: string, name = NAME) {
  let asked = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname !== "/api/current_deployment") return new Response(null, { status: 404 });
      asked++;
      return Response.json({ name, url: "http://127.0.0.1:1", adminKey: KEY });
    },
  });
  stops.push(() => server.stop(true));
  writeFileSync(join(stateDir(dir), "dashboard.json"), JSON.stringify({ port: server.port }));
  return { url: `http://127.0.0.1:${server.port}/`, asked: () => asked };
}

/** A deployable bunvex server named NAME. */
async function deployment() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: memoryStore() as never,
    exportStorage: memoryStore() as never,
  });
  stops.push(() => s.shutdown());
  return { port: s.server.port as number, url: `http://127.0.0.1:${s.server.port}` };
}

describe("which dashboard a command links", () => {
  test("the local dashboard while it serves this deployment; else none, asked once", async () => {
    const dir = localProject(1);
    // nothing saved: no link, nothing asked
    expect(await localDashboardLink(io(dir).it)()).toBeNull();
    const dash = localDashboard(dir);
    const link = localDashboardLink(io(dir).it);
    expect(await link()).toBe(dash.url);
    expect(await link()).toBe(dash.url);
    expect(dash.asked()).toBe(1);
    // the saved port now serves another deployment's dashboard
    const other = localProject(1);
    localDashboard(other, "another");
    expect(await localDashboardLink(io(other).it)()).toBeNull();
    // a saved port where nothing listens (dev stopped)
    const stopped = localProject(1);
    writeFileSync(join(stateDir(stopped), "dashboard.json"), JSON.stringify({ port: 1 }));
    expect(await localDashboardLink(io(stopped).it)()).toBeNull();
  });

  test("a self-hosted deployment, or one given by URL: never, and nothing asked", async () => {
    const dir = localProject(1);
    const dash = localDashboard(dir);
    const selfHosted = { BUNVEX_SELF_HOSTED_URL: "http://127.0.0.1:1", BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY };
    expect(await localDashboardLink(io(dir, selfHosted).it)()).toBeNull();
    expect(await localDashboardLink(io(dir).it, { url: "http://127.0.0.1:1", adminKey: KEY })()).toBeNull();
    expect(dash.asked()).toBe(0);
  });
});

describe("the push's links", () => {
  const index = (name: string, staged: boolean): IndexConfig =>
    ({ name, type: "database", fields: ["a"], staged }) as unknown as IndexConfig;

  test("a staged index: Convex's 'See progress' under each, to its table's indexes; none without a dashboard", () => {
    const diff = { added_indexes: [index("notes.by_a", false), index("notes.by_b", true)], removed_indexes: [] };
    const linked = io(tmp());
    printIndexDiff(linked.it, diff, false, "http://127.0.0.1:6790/");
    expect(linked.err).toEqual([
      "✔ Added table indexes:\n  [+] notes.by_a   a",
      "✔ Added staged table indexes:\n  [+] notes.by_b   a  (staged)\n      See progress: http://127.0.0.1:6790/database/notes?panel=indexes",
    ]);
    const plain = io(tmp());
    printIndexDiff(plain.it, diff, true);
    expect(plain.err[1]).toBe("✔ Would add staged table indexes:\n  [+] notes.by_b   a  (staged)");
  });

  test("waiting on the schema: Convex's three lines, and past 10 s where to watch", async () => {
    const at = (indexesComplete: number, indexesTotal: number, schemaValidationComplete: boolean) => ({
      type: "inProgress",
      components: { "": { indexesComplete, indexesTotal, schemaValidationComplete } },
    });
    const diff = { added_indexes: [index("notes.by_b", false)], removed_indexes: [] };
    const dash = servedDashboard("http://127.0.0.1:6790/");
    expect(await waitMessage(at(0, 1, false), diff, false, dash)).toBe(
      "Backfilling indexes (0/1 ready) and checking that documents match your schema...",
    );
    expect(await waitMessage(at(0, 1, true), diff, false, dash)).toBe("Backfilling indexes (0/1 ready)...");
    expect(await waitMessage(at(1, 1, false), diff, false, dash)).toBe("Checking that documents match your schema...");
    expect(await waitMessage(at(0, 1, false), diff, true, dash)).toBe(
      "Backfilling indexes (0/1 ready) and checking that documents match your schema...\nSee progress here: http://127.0.0.1:6790/schema",
    );
    expect(await waitMessage(at(0, 1, true), diff, true, dash)).toBe(
      "Backfilling index notes.by_b (0/1 ready), see progress here: http://127.0.0.1:6790/database/notes?panel=indexes",
    );
    expect(await waitMessage(at(1, 1, false), diff, true, dash)).toBe(
      "Checking that documents match your schema...\nSee progress here: http://127.0.0.1:6790/schema",
    );
    // no dashboard: Convex's lines without the link
    expect(await waitMessage(at(0, 1, true), diff, true, NO_DASHBOARD)).toBe("Backfilling indexes (0/1 ready)...");
    expect(await waitMessage(at(1, 1, false), diff, true, NO_DASHBOARD)).toBe(
      "Checking that documents match your schema...",
    );
  });

  test("bunvex deploy to a local deployment: the staged index and the auth config's variable link the dashboard", async () => {
    const d = await deployment();
    const app = localProject(d.port);
    const dash = localDashboard(app);
    const write = (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(app, path, ".."), { recursive: true });
        writeFileSync(join(app, path), text);
      }
    };
    write({
      "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export default defineSchema({ notes: defineTable({ a: v.string() }).index("by_a", { fields: ["a"], staged: true }) });`,
    });
    const pushed = io(app);
    expect(await main(["deploy", "--typecheck=disable", "--codegen=disable"], pushed.it)).toBe(0);
    expect(pushed.err).toContain(
      `✔ Added staged table indexes:\n  [+] notes.by_a   a, _creationTime  (staged)\n      See progress: ${dash.url}database/notes?panel=indexes`,
    );
    write({
      "bunvex/auth.config.ts": `export default { providers: [{ domain: process.env.ISSUER_DOMAIN, applicationID: "app" }] };`,
    });
    const refused = io(app);
    expect(await main(["deploy", "--typecheck=disable", "--codegen=disable"], refused.it)).toBe(1);
    expect(refused.err.at(-1)).toBe(
      `bunvex deploy: Environment variable ISSUER_DOMAIN is used in auth config file but its value was not set.\nGo to:\n\n    ${dash.url}settings/environment-variables?var=ISSUER_DOMAIN\n\n  to set it up. `,
    );
    // the same deployment as self-hosted: Convex's words for no link
    writeFileSync(join(app, ".env.local"), "");
    const selfHosted = io(app, { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY });
    expect(await main(["deploy", "--typecheck=disable", "--codegen=disable"], selfHosted.it)).toBe(1);
    expect(selfHosted.err.at(-1)).toBe(
      "bunvex deploy: Environment variable ISSUER_DOMAIN is used in auth config file but its value was not set.\nGo set it in the dashboard or using `bunvex env set`",
    );
  }, 60_000);
});

describe("export and import", () => {
  /** A deployment that answers as one with an export and an import already running. */
  function busyDeployment() {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/instance_name") return new Response(NAME);
        if (path.startsWith("/api/export/request/"))
          return Response.json(
            { code: "ExportInProgress", message: "There is already an export requested or in progress." },
            { status: 400 },
          );
        if (path === "/api/query")
          return Response.json({ status: "success", value: [{ state: { state: "in_progress" } }] });
        return Response.json({ code: "Stop", message: "stop here" }, { status: 400 });
      },
    });
    stops.push(() => server.stop(true));
    return server.port as number;
  }

  test("an export already running: Convex's words, then where to check its progress", async () => {
    const app = localProject(busyDeployment());
    const plain = io(app);
    expect(await exportCommand(["--path", "out.zip"], plain.it)).toBe(1);
    expect(plain.err.at(-1)).toBe(
      "A snapshot export is already requested or in progress. Only one can run at a time, so wait for it to finish and try again.",
    );
    const dash = localDashboard(app);
    const linked = io(app);
    expect(await exportCommand(["--path", "out.zip"], linked.it)).toBe(1);
    expect(linked.err.at(-1)).toBe(
      `A snapshot export is already requested or in progress. Only one can run at a time, so wait for it to finish and try again.\nCheck its progress at ${dash.url}settings/snapshots`,
    );
  });

  test("an import already running: where to view its progress", async () => {
    const app = localProject(busyDeployment());
    writeFileSync(join(app, "rows.jsonl"), '{"a":1}\n');
    const plain = io(app);
    expect(await importCommand(["--table", "t", "rows.jsonl", "-y"], plain.it)).toBe(1);
    expect(plain.err[0]).toBe("There is already a snapshot import in progress.");
    const dash = localDashboard(app);
    const linked = io(app);
    expect(await importCommand(["--table", "t", "rows.jsonl", "-y"], linked.it)).toBe(1);
    expect(linked.err[0]).toBe(
      `There is already a snapshot import in progress. You can view its progress at ${dash.url}settings/snapshots.`,
    );
  });

  test("a completed export links the snapshots page; self-hosted, none", async () => {
    const d = await deployment();
    const app = localProject(d.port);
    const dash = localDashboard(app);
    const linked = io(app);
    expect(await exportCommand(["--path", "a.zip"], linked.it, { pollMs: 20 })).toBe(0);
    const created = linked.err.findIndex((l) => l.startsWith("Created snapshot export"));
    expect(linked.err[created + 1]).toBe(`Export is available at ${dash.url}settings/snapshots`);
    writeFileSync(join(app, ".env.local"), "");
    const selfHosted = io(app, { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY });
    expect(await exportCommand(["--path", "b.zip"], selfHosted.it, { pollMs: 20 })).toBe(0);
    expect(selfHosted.err.some((l) => l.startsWith("Export is available"))).toBe(false);
  });
});
