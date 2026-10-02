// `bunvex start` (STUDY-37 PR 4, E1): the self-hosted server as a command. Credentials generated once in the
// data directory and reused (Convex's read_credentials.sh); `bunvex admin-key` reads them; a deploy and a run
// against it; a restart on the same data; Convex's flag checks.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, main } from "../src/index.ts";
import { checkInstanceSecret, type Started, startServer } from "../src/start.ts";

const SERVER = ["bunvex", "server"].join("/");
const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-start-"));
  dirs.push(d);
  return d;
};
const io = (cwd: string, env: Record<string, string | undefined> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { it, out, err };
};
async function start(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = io(cwd, env);
  const s = await startServer(["--port", "0", ...args], r.it);
  if (typeof s === "number") throw new Error(`start failed (${s}): ${r.err.join("\n")}`);
  stops.push(s.stop);
  return { ...(s as Started), err: r.err };
}

describe("bunvex start", () => {
  test("a fresh data directory: credentials generated and saved, a working admin key, deploy and run", async () => {
    const app = tmp();
    const s = await start(app, ["--data-dir", "data"]);
    expect(s.err[0]).toBe(`bunvex: instance bunvex-self-hosted, sqlite in ${join(app, "data")}`);
    expect(s.err[2]).toBe("bunvex: an admin key for `bunvex deploy`: bunvex admin-key --data-dir data");
    const secret = readFileSync(join(app, "data/credentials/instance_secret"), "utf8").trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(app, "data/credentials/instance_name"), "utf8").trim()).toBe("bunvex-self-hosted");
    expect(existsSync(join(app, "data/bunvex.sqlite"))).toBe(true);
    const k = io(app);
    expect(await main(["admin-key", "--data-dir", "data"], k.it)).toBe(0);
    const key = k.out[0]!;
    expect(
      (await (
        await fetch(`${s.url}/api/check_admin_key`, { headers: { authorization: `Bunvex ${key}` } })
      ).json()) as object,
    ).toMatchObject({ success: true });
    // Deploy an app to it and run a function, as one would against a Convex self-hosted backend.
    mkdirSync(join(app, "bunvex"));
    writeFileSync(
      join(app, "bunvex/hello.ts"),
      `import { mutation, query } from ${JSON.stringify(SERVER)};
export const add = mutation(async ({ db }, { n }) => { await db.insert("items", { n }); });
export const all = query(async ({ db }) => (await db.query("items").collect()).map((d) => d.n));`,
    );
    const env = { BUNVEX_SELF_HOSTED_URL: s.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: key };
    expect(await main(["deploy", "--typecheck=disable"], io(app, env).it)).toBe(0);
    expect(await main(["run", "hello:add", "{ n: 7 }"], io(app, env).it)).toBe(0);
    // Files and pushed code live in the data directory.
    expect(existsSync(join(app, "data/storage"))).toBe(true);
    // A restart on the same data: the same secret (the key still works), the code and data still there.
    await stops.pop()!();
    const again = await start(app, ["--data-dir", "data"]);
    const r = io(app, { BUNVEX_SELF_HOSTED_URL: again.url, BUNVEX_SELF_HOSTED_ADMIN_KEY: key });
    expect(await main(["run", "hello:all"], r.it)).toBe(0);
    expect(r.out).toEqual(["[\n  7\n]"]);
    expect(readFileSync(join(app, "data/credentials/instance_secret"), "utf8").trim()).toBe(secret);
  });

  test("the environment's credentials win, and are saved; flags come in pairs; Convex's checks", async () => {
    const app = tmp();
    const secret = "ab".repeat(32);
    await start(app, ["--data-dir", "d"], { INSTANCE_NAME: "mine", INSTANCE_SECRET: secret });
    expect(readFileSync(join(app, "d/credentials/instance_secret"), "utf8").trim()).toBe(secret);
    expect(readFileSync(join(app, "d/credentials/instance_name"), "utf8").trim()).toBe("mine");
    const fail = async (...args: string[]) => {
      const r = io(tmp());
      return { code: await startServer(["--port", "0", ...args], r.it), err: r.err[0] ?? "" };
    };
    expect(await fail("--instance-name", "x")).toMatchObject({
      code: 2,
      err: expect.stringContaining("--instance-name and --instance-secret go together"),
    });
    expect((await fail("--cloud-origin", "http://a")).err).toContain("--cloud-origin and --site-origin go together");
    expect((await fail("--cloud-origin", "ftp://a", "--site-origin", "http://b")).err).toContain(
      "Origin url should start with https:// or http:// but got 'ftp://a'",
    );
    expect((await fail("--instance-name", "x", "--instance-secret", "abcd")).err).toBe(
      "bunvex start: Hex-decoded key was 2 bytes, not 32",
    );
    expect((await fail("--port", "x")).err).toContain("--port must be a port number");
    expect(checkInstanceSecret("zz".repeat(32))).toBe("--instance-secret must be hex-encoded");
  });

  test("public origins are the built-in variables' values", async () => {
    const app = tmp();
    const s = await start(app, [
      "--data-dir",
      "d",
      "--cloud-origin",
      "https://api.example.com",
      "--site-origin",
      "https://site.example.com",
    ]);
    expect(s.url).toBe("https://api.example.com");
    expect(s.siteUrl).toBe("https://site.example.com");
  });
});
