// `bunvex-local-backend` (STUDY-40 L1): Convex's convex-local-backend flags, defaults and messages; `keygen
// admin-key`; the backend on SQLite in the working directory, its storage beside it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminKeyCipherKey, checkAdminKey } from "../src/admin-keys.ts";
import {
  localBackendDatabaseEnv,
  localBackendMain,
  parseLocalBackendFlags,
  startLocalBackend,
} from "../src/local-backend.ts";

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

  test("the secret from INSTANCE_SECRET (DV-525): read without the flag, the flag winning, Convex's messages", () => {
    const OTHER = "cd".repeat(32);
    expect(parseLocalBackendFlags([], { INSTANCE_SECRET: SECRET })).toMatchObject({ instanceSecret: SECRET });
    // clap's precedence for an `env =` argument: the flag, then the variable.
    expect(parseLocalBackendFlags(["--instance-secret", OTHER], { INSTANCE_SECRET: SECRET })).toMatchObject({
      instanceSecret: OTHER,
    });
    expect(parseLocalBackendFlags([`--instance-secret=${OTHER}`], { INSTANCE_SECRET: SECRET })).toMatchObject({
      instanceSecret: OTHER,
    });
    // `--instance-name` requires a secret: the variable's counts.
    expect(parseLocalBackendFlags(["--instance-name", "x"], { INSTANCE_SECRET: SECRET })).toMatchObject({
      instanceName: "x",
      instanceSecret: SECRET,
    });
    // Neither (an empty variable is none, as clap's): the messages without the variable.
    for (const env of [{}, { INSTANCE_SECRET: "" }]) {
      expect(parseLocalBackendFlags([], env)).toBe(
        "--instance-secret is required. Generate one with `openssl rand -hex 32`",
      );
      expect(parseLocalBackendFlags(["--instance-name", "x"], env)).toBe(
        "the following required arguments were not provided:\n  --instance-secret <INSTANCE_SECRET>",
      );
    }
    // The variable's value is checked as the flag's.
    expect(parseLocalBackendFlags([], { INSTANCE_SECRET: "abcd" })).toBe("Hex-decoded key was 2 bytes, not 32");
    expect(parseLocalBackendFlags([], { INSTANCE_SECRET: "xyz" })).toBe("--instance-secret must be hex-encoded");
    // Not read from the process unless given.
    process.env.INSTANCE_SECRET = SECRET;
    try {
      expect(parseLocalBackendFlags([])).toBe(
        "--instance-secret is required. Generate one with `openssl rand -hex 32`",
      );
    } finally {
      delete process.env.INSTANCE_SECRET;
    }
  });

  test("keygen admin-key reads INSTANCE_SECRET too, the flag winning (DV-525)", async () => {
    const OTHER = "cd".repeat(32);
    const keygen = async (args: string[], env: Record<string, string>) => {
      const r = io();
      const code = await localBackendMain(
        ["keygen", "admin-key", "--instance-name", "n1", ...args],
        { ...r.it, env },
        "v",
      );
      return { code, key: r.out[0], err: r.err.join("\n") };
    };
    const byEnv = await keygen([], { INSTANCE_SECRET: SECRET });
    expect(byEnv.code).toBe(0);
    expect(checkAdminKey(byEnv.key!, "n1", adminKeyCipherKey(SECRET))).toBeTruthy();
    const both = await keygen(["--instance-secret", OTHER], { INSTANCE_SECRET: SECRET });
    expect(checkAdminKey(both.key!, "n1", adminKeyCipherKey(OTHER))).toBeTruthy();
    expect(() => checkAdminKey(both.key!, "n1", adminKeyCipherKey(SECRET))).toThrow();
    const none = await keygen([], { INSTANCE_SECRET: "" });
    expect({ code: none.code, err: none.err }).toEqual({
      code: 2,
      err: "the following required arguments were not provided:\n  --instance-name <INSTANCE_NAME>\n  --instance-secret <INSTANCE_SECRET>",
    });
    expect((await keygen([], { INSTANCE_SECRET: "xyz" })).err).toBe("--instance-secret must be hex-encoded");
  });

  test("the program takes INSTANCE_SECRET from its environment and removes it there (DV-525)", async () => {
    const r = io();
    const env: Record<string, string | undefined> = { INSTANCE_SECRET: SECRET, OTHER: "kept" };
    const args = ["--db", "postgres", "postgres://u@127.0.0.1:1"];
    // Past the flags (the secret was found) to the start, which fails on the connection.
    expect(await localBackendMain(args, { ...r.it, env }, "v1")).toBe(1);
    expect(r.err).toEqual([expect.stringMatching(/^error: (?!--instance-secret)/)]);
    // What the backend starts never inherits it.
    expect(env).toEqual({ OTHER: "kept" });
    const help = io();
    await localBackendMain(["--help"], help.it, "v1");
    // `bunvex dev` looks for the variable's name in the help to give the secret there (local-deployment.ts).
    expect(help.out[0]).toContain("[env: INSTANCE_SECRET]");
  });

  test("a backend that cannot start exits 1 with the reason", async () => {
    const r = io();
    const args = ["--instance-secret", SECRET, "--db", "postgres", "postgres://u@127.0.0.1:1"];
    expect(await localBackendMain(args, r.it, "v1")).toBe(1);
    // The URL names no database: the instance's is used (DV-417), and the start fails on the connection.
    expect(r.err).toEqual([expect.stringMatching(/^error: /)]);
    expect(r.err.join("\n")).not.toMatch(/names no database/);
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

  describe("the database's variables, as Convex's binary reads them", () => {
    const flags = (...args: string[]) => {
      const f = parseLocalBackendFlags([...args, "--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0"]);
      if (typeof f === "string") throw new Error(f);
      return f;
    };
    const ENV = {
      POSTGRES_TIMEOUT_SECONDS: "4",
      MYSQL_TIMEOUT_SECONDS: "3",
      MONGODB_TIMEOUT_SECONDS: "7",
      PG_CA_FILE: "/pg.pem",
      MYSQL_CA_FILE: "/my.pem",
      // The entry script's choice of driver does not change the flags'.
      PERSISTENCE: "sqlite",
    };

    test("each driver's timeout and CA file, whatever the environment's PERSISTENCE", () => {
      expect(localBackendDatabaseEnv("postgres", ENV)).toMatchObject({ caFile: "/pg.pem", timeoutMs: 4000 });
      expect(localBackendDatabaseEnv("mysql", ENV)).toMatchObject({ caFile: "/my.pem", timeoutMs: 3000 });
      expect(localBackendDatabaseEnv("mongodb", ENV)).toMatchObject({ timeoutMs: 7000 });
    });

    test("each driver's pool and idle lifetime (STUDY-147 §3.7): Convex's knobs, else POOL, else 128 and 90 s", () => {
      expect(localBackendDatabaseEnv("postgres", {})).toEqual({ pool: 128, idleMs: 90_000 });
      expect(
        localBackendDatabaseEnv("mysql", { MYSQL_MAX_CONNECTIONS: "20", MYSQL_INACTIVE_CONNECTION_LIFETIME_SECS: "5" }),
      ).toEqual({ pool: 20, idleMs: 5000 });
      expect(localBackendDatabaseEnv("postgres", { POOL: "8" })).toEqual({ pool: 8, idleMs: 90_000 });
      expect(localBackendDatabaseEnv("mongodb", {})).toEqual({ pool: 16 });
    });

    test("unset (or another driver's), the drivers' defaults", () => {
      const env = { POSTGRES_URL: "postgres://other/db", MYSQL_TIMEOUT_SECONDS: "3", PG_CA_FILE: "" };
      expect(localBackendDatabaseEnv("postgres", env)).toEqual({ pool: 128, idleMs: 90_000 });
      expect(localBackendDatabaseEnv("postgres", {})).toEqual({ pool: 128, idleMs: 90_000 });
    });

    test("POSTGRES_TIMEOUT_SECONDS bounds the start against a database that never answers", async () => {
      // A server that accepts the connection and says nothing: without the variable, 30 s.
      const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      stops.push(() => silent.stop(true));
      const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
      dirs.push(cwd);
      const f = flags("--db", "postgres", "--do-not-require-ssl", `postgres://u@127.0.0.1:${silent.port}/db`);
      const started = performance.now();
      let err: unknown;
      try {
        const b = await startLocalBackend(f, { ...io(cwd).it, env: { POSTGRES_TIMEOUT_SECONDS: "1" } });
        stops.push(b.stop);
      } catch (e) {
        err = e;
      }
      // The driver's 1 s bound, its own retries included (about 13 s; 100 s with the default 30 s).
      expect(String(err)).toContain("no answer within 1000 ms");
      expect(performance.now() - started).toBeLessThan(60_000);
    }, 90_000);

    test("PG_CA_FILE and MYSQL_CA_FILE reach the driver", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
      dirs.push(cwd);
      for (const [db, url, variable] of [
        ["postgres", "postgres://u@127.0.0.1:1/db", "PG_CA_FILE"],
        ["mysql", "mysql://u@127.0.0.1:1/db", "MYSQL_CA_FILE"],
      ] as const) {
        const missing = join(cwd, `no-${db}.pem`);
        let err: unknown;
        try {
          const b = await startLocalBackend(flags("--db", db, url), { ...io(cwd).it, env: { [variable]: missing } });
          stops.push(b.stop);
        } catch (e) {
          err = e;
        }
        expect(String(err)).toContain(`cannot read the CA file ${missing}`);
      }
    });
  });
});
