// `bunvex network-test`, `docs`, `update` and `dashboard` (STUDY-146), against a deployment in this process and
// small servers that misbehave. Each expected line is Convex's (npm-packages/convex/src/cli/lib/networkTest.ts,
// docs.ts, update.ts, dashboard.ts) with bunvex's names.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { CHANGELOG_URL, DOCS_URL } from "../src/docs.ts";
import { type Io, main } from "../src/index.ts";
import { formatDuration, formatSize } from "../src/network-test.ts";

const SECRET = "ef".repeat(32);
const NAME = "network-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-net-"));
  dirs.push(d);
  return d;
};

async function deployment() {
  const engine = await new Engine(
    defineSchema({}),
    new SqlitePersistence(join(tmp(), "db.sqlite"), { durable: false }),
    {
      instanceName: NAME,
      instanceSecret: SECRET,
    },
  ).init();
  const s = createServer({ engine, functions: new Functions(engine), port: 0 });
  stops.push(() => s.shutdown());
  return { url: `http://127.0.0.1:${s.server.port}`, port: s.server.port };
}

/** A server answering `fetch` (the test's misbehaving deployment). */
function server(fetch: (req: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  stops.push(() => s.stop(true));
  return `http://127.0.0.1:${s.port}`;
}

function io(env: Record<string, string | undefined> = {}, open?: (url: string) => Promise<void>) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env, cwd: tmp(), out: (l) => out.push(l), err: (l) => err.push(l), ...(open ? { open } : {}) };
  return { it, out, err };
}

// A duration as Convex's `formatDuration` writes one.
const D = String.raw`[\d.,]+(ns|µs|ms|s|m)`;

describe("bunvex network-test", () => {
  test("every check passes against a deployment, as Convex prints them", async () => {
    const d = await deployment();
    const r = io();
    expect(await main(["network-test", "--url", d.url, "--admin-key", KEY], r.it)).toBe(0);
    expect(r.out).toEqual([]);
    const expected = [
      `^✔ Deployment URL: ${d.url}$`,
      `^✔ OK: DNS lookup => 127\\.0\\.0\\.1:ipv4 \\(${D}\\)$`,
      `^✔ OK: TCP connect \\(${D}\\)$`,
      `^✔ OK: HTTP check \\(${D}\\)$`,
      "^✔ OK: WebSocket connection established\\.$",
      `^✔ OK: echo 128 bytes \\(${D}, [\\d.]+ (bytes|KiB|MiB|GiB)/s\\)$`,
      `^✔ OK: echo 4 MiB \\(${D}, [\\d.]+ (bytes|KiB|MiB|GiB)/s\\)$`,
      "^✔ Network test passed\\.$",
    ];
    expect(r.err.length).toBe(expected.length);
    for (const [i, line] of r.err.entries()) expect(line).toMatch(new RegExp(expected[i]!));
  });

  test("the deployment from BUNVEX_SELF_HOSTED_*; --ip-family names the address; --speed-test echoes 64 MiB", async () => {
    const d = await deployment();
    const r = io({ BUNVEX_SELF_HOSTED_URL: d.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY });
    expect(await main(["network-test", "--ip-family", "ipv4", "--speed-test"], r.it)).toBe(0);
    expect(r.err[0]).toBe(`✔ Deployment URL: ${d.url}`);
    expect(r.err[2]).toMatch(new RegExp(`^✔ OK: TCP/ipv4 127\\.0\\.0\\.1:${d.port} connect \\(${D}\\)$`));
    expect(r.err.some((l) => l.startsWith("✔ OK: echo 64 MiB ("))).toBe(true);
    expect(r.err.at(-1)).toBe("✔ Network test passed.");
  });

  test("--url without an admin key skips the WebSocket check", async () => {
    const d = await deployment();
    const r = io();
    expect(await main(["network-test", "--url", d.url], r.it)).toBe(0);
    expect(r.err[4]).toBe("Skipping WebSocket check because no admin key was provided.");
    expect(r.err.at(-1)).toBe("✔ Network test passed.");
  });

  test("failures: no deployment, nothing listening, /instance_name not 200, echo answered wrong", async () => {
    const none = io();
    expect(await main(["network-test"], none.it)).toBe(1);
    expect(none.err).toEqual([
      "bunvex network-test: No BUNVEX_DEPLOYMENT set, run `bunvex dev` to configure a bunvex project",
    ]);

    // A port nothing listens on.
    const closed = server(() => new Response());
    stops.pop()!();
    const refused = io();
    expect(await main(["network-test", "--url", closed], refused.it)).toBe(1);
    expect(refused.err.at(-1)).toMatch(/^✖ FAIL: TCP connect \(.+\)$/);

    const unavailable = server(() => new Response("down", { status: 503 }));
    const r503 = io();
    expect(await main(["network-test", "--url", unavailable], r503.it)).toBe(1);
    expect(r503.err.at(-1)).toBe("✖ FAIL: HTTP check (Error: 503 Service Unavailable)");

    const json = server(() => Response.json({ code: "Busy", message: "try later" }, { status: 500 }));
    const r500 = io();
    expect(await main(["network-test", "--url", json], r500.it)).toBe(1);
    expect(r500.err.at(-1)).toBe("✖ FAIL: HTTP check (Error: 500 Internal Server Error: Busy: try later)");

    const created = server(() => new Response("x", { status: 201 }));
    const r201 = io();
    expect(await main(["network-test", "--url", created], r201.it)).toBe(1);
    expect(r201.err.at(-1)).toBe("✖ FAIL: HTTP check (Error: Unexpected status code: 201)");

    const garbled = server(async (req) =>
      new URL(req.url).pathname === "/echo" ? new Response(new Uint8Array(128)) : new Response("name"),
    );
    const bad = io();
    expect(await main(["network-test", "--url", garbled], bad.it)).toBe(1);
    expect(bad.err.at(-1)).toBe("✖ FAIL: echo 128 bytes (Error: Response data mismatch)");
  });

  test("a 404 from /echo is retried (Convex's `retrying…` line) until --timeout ends the test", async () => {
    const missing = server((req) => new Response("", { status: new URL(req.url).pathname === "/echo" ? 404 : 200 }));
    const r = io();
    const start = performance.now();
    expect(await main(["network-test", "--url", missing, "--timeout", "1.5"], r.it)).toBe(1);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(
      r.err.filter((l) => l === "✖ FAIL: echo 128 bytes (Received response with status 404), retrying...").length,
    ).toBe(3);
    expect(r.err.at(-1)).toBe("✖ FAIL: Network test timed out after 1.5s.");
  });

  test("a check that ends after the timeout prints nothing more", async () => {
    const slow = server(async () => {
      await Bun.sleep(600);
      return new Response("name");
    });
    const r = io();
    expect(await main(["network-test", "--url", slow, "--timeout", "0.2"], r.it)).toBe(1);
    expect(r.err.at(-1)).toBe("✖ FAIL: Network test timed out after 200ms.");
    const printed = r.err.length;
    await Bun.sleep(800);
    expect(r.err.length).toBe(printed);
  });

  test("argument errors, as commander's", async () => {
    const unknown = io();
    expect(await main(["network-test", "--speed-tst"], unknown.it)).toBe(1);
    expect(unknown.err).toEqual(["error: unknown option '--speed-tst'\n(Did you mean --speed-test?)"]);
    const extra = io();
    expect(await main(["network-test", "x"], extra.it)).toBe(1);
    expect(extra.err).toEqual(["error: too many arguments for 'network-test'. Expected 0 arguments but got 1."]);
    const missing = io();
    expect(await main(["network-test", "--timeout"], missing.it)).toBe(1);
    expect(missing.err).toEqual(["error: option '--timeout <timeout>' argument missing"]);
  });

  test("Convex's formatSize and formatDuration", () => {
    expect([128, 1536, 4 * 1024 * 1024, 1023.96 * 1024, 64 * 1024 ** 3].map(formatSize)).toEqual([
      "128 bytes",
      "1.5 KiB",
      "4 MiB",
      "1 MiB",
      "64 GiB",
    ]);
    // Convex's nanoseconds are its milliseconds times 1e9 (a factor of 1000 too many), kept as it prints them.
    expect([0.0005, 0.5, 12.345, 1234.5, 30_000, 90_000].map(formatDuration)).toEqual([
      "500,000ns",
      "500µs",
      "12.35ms",
      "1.23s",
      "30s",
      "1.5m",
    ]);
  });
});

describe("bunvex docs and update", () => {
  test("docs opens bunvex's docs; --no-open prints their URL", async () => {
    const opened: string[] = [];
    const r = io({}, async (url) => {
      opened.push(url);
    });
    expect(await main(["docs"], r.it)).toBe(0);
    expect(opened).toEqual([DOCS_URL]);
    expect(r.err).toEqual(["Docs have launched! Check your browser."]);
    const printed = io({}, async () => {
      throw new Error("must not open");
    });
    expect(await main(["docs", "--no-open"], printed.it)).toBe(0);
    expect(printed.err).toEqual([`Find bunvex docs here: ${DOCS_URL}`]);
    expect(DOCS_URL).toBe("https://bunvex.dev/?utm_source=bunvex-cli");
    const failing = io({}, async () => {
      throw new Error("spawn xdg-open ENOENT");
    });
    expect(await main(["docs"], failing.it)).toBe(1);
    expect(failing.err).toEqual(["bunvex docs: spawn xdg-open ENOENT"]);
    const extra = io();
    expect(await main(["docs", "now"], extra.it)).toBe(1);
    expect(extra.err).toEqual(["error: too many arguments for 'docs'. Expected 0 arguments but got 1."]);
  });

  test("update prints how to update, as Convex's", async () => {
    const r = io();
    expect(await main(["update"], r.it)).toBe(0);
    expect(r.out).toEqual([]);
    // npm will not allow `bunvex` (STUDY-40 L7): every `@bunvex/*` package is upgraded, together.
    expect(r.err).toEqual([
      "To view the bunvex changelog, go to https://github.com/bunvex/bunvex/blob/main/packages/server/CHANGELOG.md\nWhen you are ready to upgrade, run the following command:\nbun update --latest '@bunvex/*'\n",
    ]);
    // The changelog it names is one this repository keeps, of a package that is published.
    const changelog = CHANGELOG_URL.replace("https://github.com/bunvex/bunvex/blob/main/", "");
    expect(existsSync(join(import.meta.dir, "../../..", changelog))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../..", dirname(changelog), "package.json"), "utf8"));
    expect(pkg.private).toBeUndefined();
    const bad = io();
    expect(await main(["update", "--check"], bad.it)).toBe(1);
    expect(bad.err).toEqual(["error: unknown option '--check'"]);
  });
});

describe("bunvex dashboard", () => {
  const SELF_HOSTED =
    "Self-hosted deployment configured.\n`bunvex dashboard` is not supported for self-hosted deployments.\nSee self-hosting instructions for how to self-host the dashboard.";

  test("a self-hosted deployment: Convex's message, nothing opened; `dash` is the same command", async () => {
    const never = async () => {
      throw new Error("must not open");
    };
    for (const [args, env] of [
      [["dashboard"], { BUNVEX_SELF_HOSTED_URL: "http://127.0.0.1:1", BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY }],
      [["dash", "--url", "http://127.0.0.1:1", "--admin-key", KEY], {}],
      [["dashboard", "--no-open", "--url", "http://127.0.0.1:1", "--admin-key", KEY], {}],
    ] as const) {
      const r = io(env, never);
      expect(await main([...args], r.it)).toBe(0);
      expect(r.err).toEqual([SELF_HOSTED]);
      expect(r.out).toEqual([]);
    }
  });

  test("a local deployment whose dashboard is not running: Convex's warning", async () => {
    const r = io({ BUNVEX_DEPLOYMENT: "local:anonymous-app" });
    expect(await main(["dashboard"], r.it)).toBe(0);
    expect(r.err).toEqual([
      "You are not currently running the dashboard locally. Make sure `bunvex dev` is running and try again.",
    ]);
  });

  test("no deployment, conflicting variables, argument errors (with the help, as Convex's)", async () => {
    const none = io();
    expect(await main(["dashboard"], none.it)).toBe(1);
    expect(none.err).toEqual([
      "bunvex dashboard: No BUNVEX_DEPLOYMENT set, run `bunvex dev` to configure a bunvex project",
    ]);
    const both = io({
      BUNVEX_DEPLOYMENT: "local:x",
      BUNVEX_SELF_HOSTED_URL: "http://a",
      BUNVEX_SELF_HOSTED_ADMIN_KEY: "k",
    });
    expect(await main(["dashboard"], both.it)).toBe(1);
    expect(both.err[0]).toStartWith("bunvex dashboard: BUNVEX_DEPLOYMENT must not be set");
    const extra = io();
    expect(await main(["dashboard", "x"], extra.it)).toBe(1);
    expect(extra.err[0]).toBe("error: too many arguments for 'dashboard'. Expected 0 arguments but got 1.");
    expect(extra.err[2]).toStartWith("Usage: bunvex dashboard|dash [options]");
  });
});
