// The version check (AD-29, STUDY-146 §7): the registry asked through `BUNVEX_VERSION_API_ORIGIN` (a server in
// this process), the answer cached for a day under `$HOME/.cache/bunvex`, off in CI and by variable, and silent on
// every failure.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForNewerVersion,
  VERSION_CHECK_TTL_MS,
  versionCheckDisabled,
  versionNotice,
} from "../src/version-check.ts";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A registry answering `bunvex/latest` with `answer`; the requests it got. */
function registry(answer: (req: Request) => Response | Promise<Response>) {
  const requests: string[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      requests.push(new URL(req.url).pathname);
      return answer(req);
    },
  });
  stops.push(() => s.stop(true));
  return { origin: `http://127.0.0.1:${s.port}`, requests };
}

const home = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-home-"));
  dirs.push(d);
  return d;
};

const NOTICE =
  "A newer version of bunvex is available: 0.2.0 (this is 0.1.0). Run `bunvex update` to see how to upgrade.";

describe("the version check", () => {
  test("the notice only for a newer version, prereleases ordered as semver", () => {
    expect(versionNotice("0.1.0", "0.2.0")).toBe(NOTICE);
    expect(versionNotice("0.1.0-alpha.1", "0.1.0")).toContain("available: 0.1.0 (this is 0.1.0-alpha.1)");
    expect(versionNotice("0.1.0-alpha.1", "0.1.0-alpha.2")).not.toBeNull();
    expect(versionNotice("0.2.0", "0.2.0")).toBeNull();
    expect(versionNotice("0.3.0", "0.2.0")).toBeNull();
  });

  test("asks `<origin>/bunvex/latest` once a day: the answer is cached", async () => {
    const r = registry(() => Response.json({ name: "bunvex", version: "0.2.0" }));
    const env = { HOME: home(), BUNVEX_VERSION_API_ORIGIN: `${r.origin}/` };
    let now = 1_000_000;
    const check = () => checkForNewerVersion(env, { installed: "0.1.0", now: () => now });
    expect(await check()).toBe(NOTICE);
    expect(r.requests).toEqual(["/bunvex/latest"]);
    expect(existsSync(join(env.HOME, ".cache", "bunvex", "version-check.json"))).toBe(true);
    now += VERSION_CHECK_TTL_MS - 1;
    expect(await check()).toBe(NOTICE);
    expect(r.requests.length).toBe(1);
    // An up-to-date CLI says nothing, from the same cached answer.
    expect(await checkForNewerVersion(env, { installed: "0.2.0", now: () => now })).toBeNull();
    now += 1;
    expect(await check()).toBe(NOTICE);
    expect(r.requests.length).toBe(2);
  });

  test("off in CI, with BUNVEX_DISABLE_VERSION_CHECK or NO_UPDATE_NOTIFIER: the registry is not asked", async () => {
    const r = registry(() => Response.json({ version: "0.2.0" }));
    for (const off of [{ CI: "true" }, { BUNVEX_DISABLE_VERSION_CHECK: "1" }, { NO_UPDATE_NOTIFIER: "1" }]) {
      const env = { HOME: home(), BUNVEX_VERSION_API_ORIGIN: r.origin, ...off };
      expect(versionCheckDisabled(env)).toBe(true);
      expect(await checkForNewerVersion(env, { installed: "0.1.0" })).toBeNull();
    }
    expect(r.requests).toEqual([]);
    expect(versionCheckDisabled({ CI: "" })).toBe(false);
  });

  test("every failure is silent, quick and not cached", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("Not Found", { status: 404 }),
      () => new Response("not json"),
      () => Response.json({ version: "latest" }),
      async () => {
        await Bun.sleep(2000);
        return Response.json({ version: "0.2.0" });
      },
    ];
    for (const answer of answers) {
      const r = registry(answer);
      const env = { HOME: home(), BUNVEX_VERSION_API_ORIGIN: r.origin };
      const start = performance.now();
      expect(await checkForNewerVersion(env, { installed: "0.1.0", timeoutMs: 200 })).toBeNull();
      expect(performance.now() - start).toBeLessThan(1000);
      expect(existsSync(join(env.HOME, ".cache", "bunvex", "version-check.json"))).toBe(false);
    }
    // Nothing listening, and a cache that is not JSON.
    const closed = registry(() => new Response());
    await stops.pop()!();
    const env = { HOME: home(), BUNVEX_VERSION_API_ORIGIN: closed.origin };
    expect(await checkForNewerVersion(env, { installed: "0.1.0" })).toBeNull();
    const broken = home();
    const r = registry(() => Response.json({ version: "0.2.0" }));
    const cache = join(broken, ".cache", "bunvex");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "version-check.json"), "{");
    expect(
      await checkForNewerVersion({ HOME: broken, BUNVEX_VERSION_API_ORIGIN: r.origin }, { installed: "0.1.0" }),
    ).toBe(NOTICE);
  });
});
