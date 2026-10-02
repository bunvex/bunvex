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
});
