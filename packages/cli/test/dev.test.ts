// `bunvex dev` (STUDY-37 PR 5): push, watch, push again; Convex's error handling (an app error waits for
// the next change, an unreachable deployment backs off), `--once`, `--until-success`, `--run`, `--start`,
// (local deployments: local-deployment.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { announceTarget, configurationLines, devCommand, nextSteps } from "../src/dev.ts";
import type { Io } from "../src/io.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "34".repeat(32);
const NAME = "dev-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = ["bunvex", "server"].join("/");

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-dev-"));
  dirs.push(d);
  return d;
};
const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
};
const hello = (word: string) =>
  `import { query } from ${JSON.stringify(SERVER)};\nexport const hi = query(async () => ${JSON.stringify(word)});`;

async function deployment() {
  const engine = await new Engine(
    defineSchema({}),
    new SqlitePersistence(join(tmp(), "db.sqlite"), { durable: true }),
    {
      instanceName: NAME,
      instanceSecret: SECRET,
      storedSchema: true,
    },
  ).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: memoryStore() as never,
  });
  stops.push(() => s.shutdown());
  const url = `http://127.0.0.1:${s.server.port}`;
  const query = async (path: string) =>
    (await (
      await fetch(`${url}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: {} }),
      })
    ).json()) as {
      status: string;
      value?: unknown;
    };
  return { url, query };
}

function dev(cwd: string, url: string | null, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = {
    env: url ? { BUNVEX_SELF_HOSTED_URL: url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY } : {},
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  const ctl = new AbortController();
  const done = devCommand(["--typecheck=disable", ...args], it, { signal: ctl.signal });
  stops.push(async () => {
    ctl.abort();
    await done;
  });
  const until = async (pred: () => boolean | Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > end) throw new Error(`timed out; stderr:\n${err.join("\n")}`);
      await Bun.sleep(25);
    }
  };
  const ready = () => err.filter((l) => / bunvex functions ready! \(/.test(l)).length;
  return { out, err, done, stop: () => ctl.abort(), until, ready };
}

describe("dev's lines, as Convex's", () => {
  test("the deployment it works on: a self-hosted one by its URL; a local one by its port and dashboard", () => {
    const plain = { env: {}, cwd: "/", out: () => {}, err: () => {} };
    expect(announceTarget("http://h:1", null, plain)).toBe("▌ Developing against deployment:\n▌ └─ http://h:1");
    expect(announceTarget("http://127.0.0.1:3210", { port: 3210, dashboard: "http://127.0.0.1:6790/" }, plain)).toBe(
      "▌ Developing against deployment:\n▌ [Local] Port 3210 (dashboard: http://127.0.0.1:6790/)\n▌ └─ http://127.0.0.1:3210",
    );
    expect(announceTarget("http://127.0.0.1:3210", { port: 3210, dashboard: null }, plain)).toContain(
      "▌ [Local] Port 3210\n",
    );
    // on a terminal, links (OSC 8)
    const tty = announceTarget("http://h:1", { port: 1, dashboard: "http://d/" }, { ...plain, isTTY: true });
    expect(tty).toContain("(\x1b]8;;http://d/\x1b\\dashboard\x1b]8;;\x1b\\)");
    expect(tty).toContain("└─ \x1b]8;;http://h:1\x1b\\http://h:1\x1b]8;;\x1b\\");
  });

  test("the configuration lines: only what changed; the .gitignore line; none for no change", () => {
    const none = { deployment: false, url: null, site: null, gitignore: false };
    expect(configurationLines("http://u", none)).toBeNull();
    expect(configurationLines("http://u", { ...none, deployment: true })).toBe(
      "✔ Configured a local deployment for http://u and saved its name as BUNVEX_DEPLOYMENT to .env.local",
    );
    expect(configurationLines("http://u", { ...none, url: "BUNVEX_URL", gitignore: true })).toBe(
      '✔ Configured a local deployment for http://u and saved its:\n    client URL as BUNVEX_URL\n to .env.local\n  Added ".env.local" to .gitignore',
    );
    expect(configurationLines("http://u", { ...none, gitignore: true })).toBe('  Added ".env.local" to .gitignore');
  });

  test("the closing lines: the functions' directory, feedback, and the dashboard only while one serves", () => {
    expect(nextSteps("/p/src/fns", "/p", "http://d/")).toBe(
      "\nWrite your bunvex functions in src/fns/\nGive us feedback at https://github.com/bunvex/bunvex/issues\nView the bunvex dashboard at http://d/\n",
    );
    expect(nextSteps("/p/bunvex", "/p", null)).not.toContain("View");
  });
});

describe("bunvex dev", () => {
  test("self-hosted: the deployment's URLs saved to .env.local once, as Convex's", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("hi") });
    const first = dev(app, d.url, "--once");
    expect(await first.done).toBe(0);
    expect(first.err.slice(0, 2)).toEqual([
      "Saved BUNVEX_URL and BUNVEX_SITE_URL to .env.local",
      `▌ Developing against deployment:\n▌ └─ ${d.url}`,
    ]);
    const env = readFileSync(join(app, ".env.local"), "utf8");
    expect(env).toContain(`BUNVEX_URL=${d.url}`);
    expect(env).toMatch(/BUNVEX_SITE_URL=http/);
    const again = dev(app, d.url, "--once");
    expect(await again.done).toBe(0);
    expect(again.err[0]).toBe(`▌ Developing against deployment:\n▌ └─ ${d.url}`);
  });

  test("--url and --admin-key over a configured deployment: BUNVEX_DEPLOYMENT removed from .env.local", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("hi"), ".env.local": "BUNVEX_DEPLOYMENT=local:old\n" });
    const err: string[] = [];
    const it: Io = { env: {}, cwd: app, out: () => {}, err: (l) => err.push(l) };
    const args = ["--once", "--typecheck=disable", "--url", d.url, "--admin-key", KEY];
    expect(await devCommand(args, it)).toBe(0);
    expect(err[0]).toBe("Removed the BUNVEX_DEPLOYMENT environment variable from .env.local");
    expect(readFileSync(join(app, ".env.local"), "utf8")).not.toContain("BUNVEX_DEPLOYMENT");
  });

  test("--once: one push, Convex's ready line; an app error exits 1", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("hi") });
    const ok = dev(app, d.url, "--once");
    expect(await ok.done).toBe(0);
    // Convex's `formatDuration`: at most two decimals, in ns, µs, ms, s or m
    expect(ok.err.at(-1)).toMatch(/^✔ \d\d:\d\d:\d\d bunvex functions ready! \(\d+(\.\d{1,2})?(ns|µs|ms|s|m)\)$/);
    expect(ok.out).toEqual([]); // `deploy`'s own success line is replaced
    expect((await d.query("hello:hi")).value).toBe("hi");
    write(app, { "bunvex/broken.ts": `import { nope } from "./missing"; export const x = nope;` });
    expect(await dev(app, d.url, "--once").done).toBe(1);
  });

  test("the version check's notice (AD-29) is printed beside the first push", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("hi") });
    const err: string[] = [];
    const notice =
      "A newer version of bunvex is available: 9.9.9 (this is 0.1.0). Run `bunvex update` to see how to upgrade.";
    const it: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
      cwd: app,
      out: () => {},
      err: (l) => err.push(l),
      versionCheck: async () => notice,
    };
    expect(await devCommand(["--typecheck=disable", "--once"], it)).toBe(0);
    expect(err.filter((l) => l === notice).length).toBe(1);
  });

  test("watching: a change is pushed again; _generated/ writes do not loop", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("one") });
    const w = dev(app, d.url);
    await w.until(() => w.ready() === 1);
    await Bun.sleep(1500); // the first push's codegen wrote _generated/: no push follows
    expect(w.ready()).toBe(1);
    write(app, { "bunvex/hello.ts": hello("two") });
    await w.until(async () => (await d.query("hello:hi")).value === "two");
    await Bun.sleep(1500); // codegen rewrote _generated/: no further push
    expect(w.ready()).toBe(2);
    w.stop();
    expect(await w.done).toBe(0);
    // 3 s of sleeps by design, two pushes (each `until` allows 10 s): 3.6 s in CI's coverage job, close to
    // the default 5 s
  }, 30_000);

  test("--until-success: an app error waits for the change that fixes it", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": `${hello("x")}\nexport const bad = ;` });
    const w = dev(app, d.url, "--until-success");
    await w.until(() => w.err.some((l) => l.startsWith("bunvex deploy:")));
    write(app, { "bunvex/hello.ts": hello("fixed") });
    expect(await w.done).toBe(0);
    expect((await d.query("hello:hi")).value).toBe("fixed");
  });

  test("--run after the first push; --start's failure ends dev", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("ran") });
    const r = dev(app, d.url, "--run", "hello:hi", "--once");
    expect(await r.done).toBe(0);
    expect(r.out).toEqual(['"ran"']);
    expect(r.err).toContain('Finished running function "hello:hi"');
    const s = dev(app, d.url, "--start", "exit 3");
    expect(await s.done).toBe(1);
    expect(s.err).toContain("Command `exit 3` exited with code 3");
    // Both: `--run` wins and `--start` is not run, as Convex's (its conflict check never fires, STUDY-124).
    const both = dev(app, d.url, "--run", "hello:hi", "--start", "echo started > started.txt");
    await both.until(() => both.out.includes('"ran"'));
    await Bun.sleep(500);
    expect(existsSync(join(app, "started.txt"))).toBe(false);
    both.stop();
    expect(await both.done).toBe(0);
  });

  test("the deployment's function logs on stderr (pause-on-deploy by default); --tail-logs disable", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, {
      "bunvex/hello.ts": `import { query } from ${JSON.stringify(SERVER)};\nexport const hi = query(async () => { console.log("from app"); return 1; });`,
    });
    // As Convex's, the tail's first poll only finds the head: with an empty log it waits for the first
    // execution and skips it. One has run before here.
    expect(await dev(app, d.url, "--once").done).toBe(0);
    await d.query("hello:hi");
    const w = dev(app, d.url);
    await w.until(() => w.ready() === 1);
    await Bun.sleep(200);
    await d.query("hello:hi");
    await w.until(() => w.err.some((l) => / \[BUNVEX Q\(hello:hi\)\] \[LOG\] 'from app'$/.test(l)));
    w.stop();
    expect(await w.done).toBe(0);
    const quiet = dev(app, d.url, "--tail-logs", "disable");
    await quiet.until(() => quiet.ready() === 1);
    await Bun.sleep(200);
    await d.query("hello:hi");
    await Bun.sleep(300);
    expect(quiet.err.some((l) => l.includes("[BUNVEX "))).toBe(false);
  }, 30_000);

  test("an auth config reading an unset variable: Convex's message, then a push once the variable is set", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, {
      "bunvex/hello.ts": hello("authed"),
      "bunvex/auth.config.ts": `export default { providers: [{ domain: process.env.ISSUER_DOMAIN, applicationID: "app" }] };`,
    });
    const w = dev(app, d.url);
    await w.until(() => w.err.some((l) => l.startsWith("bunvex deploy:")));
    expect(w.err.find((l) => l.startsWith("bunvex deploy:"))).toBe(
      "bunvex deploy: Environment variable ISSUER_DOMAIN is used in auth config file but its value was not set.\nGo set it in the dashboard or using `bunvex env set`",
    );
    expect(w.ready()).toBe(0);
    // No file changes: setting the variable is what makes dev push again (Convex's env var watch).
    await Bun.sleep(300);
    const set = await fetch(`${d.url}/api/update_environment_variables`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
      body: JSON.stringify({ changes: [{ name: "ISSUER_DOMAIN", value: "https://issuer.example" }] }),
    });
    expect(set.status).toBe(200);
    await w.until(() => w.ready() === 1);
    expect((await d.query("hello:hi")).value).toBe("authed");
    w.stop();
    expect(await w.done).toBe(0);
  }, 30_000);

  test("a schema its documents fail: Convex's message, then a push once the table changes (STUDY-120)", async () => {
    const d = await deployment();
    const app = tmp();
    const values = ["bunvex", "values"].join("/");
    write(app, {
      "bunvex/messages.ts": `import { mutation } from ${JSON.stringify(SERVER)};
export const add = mutation(async ({ db }) => { await db.insert("messages", { body: 1 }); });
export const fix = mutation(async ({ db }) => {
  for (const m of await db.query("messages").collect()) await db.patch(m._id, { body: "fixed" });
});
export const other = mutation(async ({ db }) => { await db.insert("others", {}); });`,
    });
    const w = dev(app, d.url);
    await w.until(() => w.ready() === 1);
    const call = (path: string) =>
      fetch(`${d.url}/api/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
        body: JSON.stringify({ path, args: {} }),
      });
    expect((await call("messages:add")).status).toBe(200);
    // A schema the stored document does not match.
    write(app, {
      "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(values)};
export default defineSchema({ messages: defineTable({ body: v.string() }) });`,
    });
    await w.until(() => w.err.some((l) => l.startsWith("✖ Schema validation failed.")));
    const failure = w.err.find((l) => l.startsWith("✖ Schema validation failed."))!;
    // Convex's two lines: the failure, then the error (which names the table and the document).
    expect(failure.split("\n")[0]).toBe("✖ Schema validation failed.");
    expect(failure.split("\n")[1]).toContain('"messages"');
    expect(w.ready()).toBe(1);
    // An unrelated table changing does not push.
    await Bun.sleep(300);
    expect((await call("messages:other")).status).toBe(200);
    await Bun.sleep(700);
    expect(w.ready()).toBe(1);
    // No file changes: fixing the document is what makes dev push again (Convex's table watch).
    expect((await call("messages:fix")).status).toBe(200);
    await w.until(() => w.ready() === 2);
    expect(w.err.filter((l) => l.startsWith("✖ Schema validation failed."))).toHaveLength(1);
    w.stop();
    expect(await w.done).toBe(0);
  }, 30_000);

  test("_system/cli/queryTable: a new result whenever the table changes, ViewData only", async () => {
    const d = await deployment();
    const sys = async (key: string | null) =>
      (await (
        await fetch(`${d.url}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bunvex ${key}` } : {}) },
          body: JSON.stringify({ path: "_system/cli/queryTable", args: { tableName: "messages" }, format: "json" }),
        })
      ).json()) as { status: string; value?: unknown; errorMessage?: string };
    const a = await sys(KEY);
    expect(a.status).toBe("success");
    expect(typeof a.value).toBe("number");
    expect(a.value as number).toBeGreaterThanOrEqual(0);
    expect(a.value as number).toBeLessThan(1);
    expect((await sys(null)).status).not.toBe("success");
  });

  test("an unreachable deployment: backoff and retry; with --once, exit 1", async () => {
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("x") });
    const closed = "http://127.0.0.1:1";
    expect(await dev(app, closed, "--once").done).toBe(1);
    const w = dev(app, closed);
    await w.until(() => w.err.filter((l) => l.startsWith("Failed due to network error, retrying in")).length >= 2);
    w.stop();
    expect(await w.done).toBe(0);
  });
});
