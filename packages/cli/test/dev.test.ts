// `bunvex dev` (STUDY-37 PR 5): push, watch, push again; Convex's error handling (an app error waits for
// the next change, an unreachable deployment backs off), `--once`, `--until-success`, `--run`, `--start`,
// (local deployments: local-deployment.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { devCommand } from "../src/dev.ts";
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
    (await (await fetch(`${url}/api/query`, { method: "POST", body: JSON.stringify({ path, args: {} }) })).json()) as {
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

describe("bunvex dev", () => {
  test("--once: one push, Convex's ready line; an app error exits 1", async () => {
    const d = await deployment();
    const app = tmp();
    write(app, { "bunvex/hello.ts": hello("hi") });
    const ok = dev(app, d.url, "--once");
    expect(await ok.done).toBe(0);
    expect(ok.err.at(-1)).toMatch(/^✔ \d\d:\d\d:\d\d bunvex functions ready! \(\d+\.\d\ds\)$/);
    expect(ok.out).toEqual([]); // `deploy`'s own success line is replaced
    expect((await d.query("hello:hi")).value).toBe("hi");
    write(app, { "bunvex/broken.ts": `import { nope } from "./missing"; export const x = nope;` });
    expect(await dev(app, d.url, "--once").done).toBe(1);
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
  });

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
    expect(await dev(app, d.url, "--run", "a:b", "--start", "true").done).toBe(2);
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
