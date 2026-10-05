// `bunvex-local-backend` (STUDY-40 L1): Convex's convex-local-backend flags, defaults and messages; `keygen
// admin-key`; the backend on SQLite in the working directory, its storage beside it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBackendMain, parseLocalBackendFlags, startLocalBackend } from "../src/local-backend.ts";

const SECRET = "ab".repeat(32);
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const io = (cwd = ".") => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, it: { env: {}, cwd, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("bunvex-local-backend", () => {
  test("Convex's defaults", () => {
    expect(parseLocalBackendFlags(["--instance-secret", SECRET])).toEqual({
      dbSpec: "bunvex_local_backend.sqlite3",
      db: "sqlite",
      hostname: "0.0.0.0",
      port: 3210,
      sitePort: 3211,
      instanceName: "bunvex-self-hosted",
      instanceSecret: SECRET,
      localStorage: "bunvex_local_storage",
      s3: false,
      doNotRequireSsl: false,
      redact: false,
    });
    expect(
      parseLocalBackendFlags(["-p", "4000", "--db", "postgres", "postgres://h/db", "--instance-secret", SECRET]),
    ).toMatchObject({
      port: 4000,
      db: "postgres",
      dbSpec: "postgres://h/db",
    });
  });

  test("Convex's checks and messages", () => {
    expect(parseLocalBackendFlags([])).toBe("--instance-secret is required. Generate one with `openssl rand -hex 32`");
    expect(parseLocalBackendFlags(["--instance-name", "x"])).toContain("--instance-secret <INSTANCE_SECRET>");
    expect(parseLocalBackendFlags(["--instance-secret", "abcd"])).toBe("Hex-decoded key was 2 bytes, not 32");
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--cloud-origin", "http://a"])).toContain(
      "--site-origin",
    );
    expect(
      parseLocalBackendFlags(["--instance-secret", SECRET, "--cloud-origin", "ftp://a", "--site-origin", "http://b"]),
    ).toBe("Origin url should start with https:// or http:// but got 'ftp://a'");
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--s3-storage", "--local-storage", "d"])).toContain(
      "cannot be used with",
    );
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--db", "postgres"])).toContain(
      "needs the database's URL",
    );
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--db", "oracle"])).toContain("possible values");
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--bogus"])).toBe(
      "unexpected argument '--bogus' found",
    );
  });

  test("keygen admin-key prints a key; --version; a usage error exits 2", async () => {
    const k = io();
    expect(
      await localBackendMain(["keygen", "admin-key", "--instance-name", "n1", "--instance-secret", SECRET], k.it, "v1"),
    ).toBe(0);
    expect(k.out[0]).toStartWith("n1|");
    const v = io();
    expect(await localBackendMain(["--version"], v.it, "v1")).toBe(0);
    expect(v.out).toEqual(["bunvex-local-backend v1"]);
    const bad = io();
    expect(await localBackendMain([], bad.it, "v1")).toBe(2);
    expect(bad.err[0]).toStartWith("error: --instance-secret is required.");
  });

  test("runs on SQLite in the working directory, storage beside it; the key works", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
    dirs.push(cwd);
    const flags = parseLocalBackendFlags(["--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0"]);
    if (typeof flags === "string") throw new Error(flags);
    const b = await startLocalBackend(flags, io(cwd).it);
    stops.push(b.stop);
    expect(await (await fetch(`${b.url}/instance_name`)).text()).toBe("bunvex-self-hosted");
    expect(existsSync(join(cwd, "bunvex_local_backend.sqlite3"))).toBe(true);
    expect(existsSync(join(cwd, "bunvex_local_storage/modules"))).toBe(true);
    const k = io();
    await localBackendMain(
      ["keygen", "admin-key", "--instance-name", "bunvex-self-hosted", "--instance-secret", SECRET],
      k.it,
      "v",
    );
    const r = await fetch(`${b.url}/api/check_admin_key`, { headers: { authorization: `Bunvex ${k.out[0]}` } });
    expect(r.status).toBe(200);
  });
  test("--help; keygen's usage errors exit 2 with Convex's messages", async () => {
    const h = io();
    expect(await localBackendMain(["--port", "1", "--help"], h.it, "v1")).toBe(0);
    expect(h.out[0]).toContain("-h, --help");
    const run = async (args: string[]) => {
      const r = io();
      return { code: await localBackendMain(["keygen", ...args], r.it, "v1"), err: r.err.join("\n") };
    };
    expect(await run(["other"])).toEqual({
      code: 2,
      err: "Usage: bunvex-local-backend keygen admin-key --instance-name <name> --instance-secret <hex>",
    });
    expect(await run(["admin-key", "--instance-name", "n", "--bogus"])).toEqual({
      code: 2,
      err: "unexpected argument '--bogus' found",
    });
    const missing = await run(["admin-key", "--instance-name", "n"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--instance-secret <INSTANCE_SECRET>");
    const bad = await run(["admin-key", "--instance-name", "n", "--instance-secret", "xyz"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toBe(parseLocalBackendFlags(["--instance-secret", "xyz"]) as string);
  });

  test("a backend that cannot start exits 1 with the reason", async () => {
    const r = io();
    const args = ["--instance-secret", SECRET, "--db", "postgres", "postgres://u@127.0.0.1:1"];
    expect(await localBackendMain(args, r.it, "v1")).toBe(1);
    expect(r.err).toEqual([expect.stringMatching(/^error: PERSISTENCE_URL names no database/)]);
  });

  test("runs until SIGTERM: announces its URLs, serves, then stops", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
    dirs.push(cwd);
    const r = io(cwd);
    const exit = localBackendMain(
      ["--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0", "--redact-logs-to-client"],
      r.it,
      "v9",
    );
    for (let i = 0; i < 500 && r.err.length < 2; i++) await Bun.sleep(10);
    expect(r.err[0]).toBe("bunvex-local-backend v9: instance bunvex-self-hosted, sqlite");
    const url = /the API at (\S+?)(,|$)/.exec(r.err[1]!)![1]!;
    expect(r.err[1]).toContain(", HTTP actions at http://");
    expect(await (await fetch(`${url}/instance_name`)).text()).toBe("bunvex-self-hosted");
    process.emit("SIGTERM");
    expect(await exit).toBe(0);
    expect(r.err.at(-1)).toBe("bunvex-local-backend: stopping");
    await expect(fetch(`${url}/instance_name`)).rejects.toThrow();
  });

  test("--s3-storage: a use case with a bucket goes to S3, the others stay local; --cloud-origin is the URL", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
    dirs.push(cwd);
    const flags = parseLocalBackendFlags([
      "--instance-secret",
      SECRET,
      "--port",
      "0",
      "--site-proxy-port",
      "0",
      "--s3-storage",
      "--cloud-origin",
      "https://api.example.test/",
      "--site-origin",
      "https://site.example.test",
    ]);
    if (typeof flags === "string") throw new Error(flags);
    const it = { ...io(cwd).it, env: { S3_STORAGE_FILES_BUCKET: "files-bucket", AWS_REGION: "us-east-1" } };
    const b = await startLocalBackend(flags, it);
    stops.push(b.stop);
    expect(b.url).toBe("https://api.example.test");
    expect(existsSync(join(cwd, "bunvex_local_storage/modules"))).toBe(true);
    expect(existsSync(join(cwd, "bunvex_local_storage/files"))).toBe(false);
  });
  test("the storage is pinned at the first start (STUDY-126): a restart with --s3-storage is refused", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
    dirs.push(cwd);
    const local = parseLocalBackendFlags(["--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0"]);
    if (typeof local === "string") throw new Error(local);
    const a = await startLocalBackend(local, io(cwd).it);
    await a.stop();
    const s3 = parseLocalBackendFlags([
      "--instance-secret",
      SECRET,
      "--port",
      "0",
      "--site-proxy-port",
      "0",
      "--s3-storage",
    ]);
    if (typeof s3 === "string") throw new Error(s3);
    const it = { ...io(cwd).it, env: { S3_STORAGE_FILES_BUCKET: "files-bucket", AWS_REGION: "us-east-1" } };
    await expect(startLocalBackend(s3, it)).rejects.toThrow(
      'Database was initialized with Some(Local { dir: "bunvex_local_storage" }), but backend started up with S3.',
    );
    // The refused start released the store: the local one starts again.
    const b = await startLocalBackend(local, io(cwd).it);
    stops.push(b.stop);
    expect(await (await fetch(`${b.url}/instance_name`)).text()).toBe("bunvex-self-hosted");
  });
});
