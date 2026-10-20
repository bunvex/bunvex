// `bunvex-local-backend` (STUDY-40 L1): Convex's convex-local-backend flags, defaults and messages; `keygen
// admin-key`; the backend on SQLite in the working directory, its storage beside it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminKeyCipherKey, checkAdminKey } from "../src/admin-keys.ts";
import {
  ADMIN_KEY_USAGE,
  instanceSecretError,
  KEYGEN_USAGE,
  LOCAL_BACKEND_USAGE,
  localBackendDatabaseEnv,
  localBackendFlagsError,
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
/** clap's error text: the message, then its trailer (STUDY-172). */
const clap = (message: string, usage?: string) =>
  `error: ${message}\n\n${usage ? `${usage}\n\n` : ""}For more information, try '--help'.`;
const HELP_USAGE = "Usage: bunvex-local-backend [OPTIONS] [DB_SPEC] [COMMAND]";
/** What Convex refuses once the flags parse, checked as the program checks it. */
const refused = (args: string[], env: Record<string, string | undefined> = {}) => {
  const f = parseLocalBackendFlags(args, env);
  if (typeof f === "string") throw new Error(f);
  return localBackendFlagsError(f);
};
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
    expect(refused([])).toBe("--instance-secret is required. Generate one with `openssl rand -hex 32`");
    expect(parseLocalBackendFlags(["--instance-name", "x"])).toBe(
      clap(
        "the following required arguments were not provided:\n  --instance-secret <INSTANCE_SECRET>",
        "Usage: bunvex-local-backend --instance-secret <INSTANCE_SECRET> --instance-name <INSTANCE_NAME> [DB_SPEC]",
      ),
    );
    expect(refused(["--instance-secret", "abcd"])).toBe("Hex-decoded key was 2 bytes, not 32");
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--cloud-origin", "http://a"])).toBe(
      clap(
        "the following required arguments were not provided:\n  --site-origin <SITE_ORIGIN>",
        "Usage: bunvex-local-backend --cloud-origin <CLOUD_ORIGIN> --site-origin <SITE_ORIGIN> --instance-secret <INSTANCE_SECRET> [DB_SPEC]",
      ),
    );
    expect(refused(["--instance-secret", SECRET, "--cloud-origin", "ftp://a", "--site-origin", "http://b"])).toBe(
      "Origin url should start with https:// or http:// but got 'ftp://a'",
    );
    expect(refused(["--instance-secret", SECRET, "--cloud-origin", "http://a", "--site-origin", "ftp://b"])).toBe(
      "Site url should start with https:// or http:// but got 'ftp://b'",
    );
    // Empty origins are allowed, as Convex's: present, so the pair is complete.
    expect(refused(["--instance-secret", SECRET, "--cloud-origin=", "--site-origin="])).toBeNull();
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--s3-storage", "--local-storage", "d"])).toBe(
      clap(
        "the argument '--s3-storage' cannot be used with '--local-storage <LOCAL_STORAGE>'",
        "Usage: bunvex-local-backend --instance-secret <INSTANCE_SECRET> --s3-storage [DB_SPEC]",
      ),
    );
    expect(refused(["--instance-secret", SECRET, "--db", "postgres"])).toBe(
      "--db postgres needs the database's URL as the db_spec argument",
    );
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--db", "oracle"])).toBe(
      "error: invalid value 'oracle' for '--db <DB>'\n  [possible values: sqlite, postgres, mysql, mongodb]\n\nFor more information, try '--help'.",
    );
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--bogus"])).toBe(
      clap(
        "unexpected argument '--bogus' found\n\n  tip: to pass '--bogus' as a value, use '-- --bogus'",
        "Usage: bunvex-local-backend <DB_SPEC|--db <DB>|--interface <INTERFACE>|--port <PORT>|--site-proxy-port <SITE_PROXY_PORT>|--cloud-origin <CLOUD_ORIGIN>|--site-origin <SITE_ORIGIN>|--http-proxy <HTTP_PROXY>|--deny-addresses <DENY_ADDRESSES>|--instance-name <INSTANCE_NAME>|--instance-secret <INSTANCE_SECRET>|--local-storage <LOCAL_STORAGE>|--s3-storage|--do-not-require-ssl|--redact-logs-to-client|--function-sandbox <FUNCTION_SANDBOX>>",
      ),
    );
  });

  // Captured from Convex's binary (precompiled-2026-10-07-d8bdde0) in STUDY-172 §1; checked against it by
  // differential/test/backend-flags.test.ts when it is there.
  test("a value missing: clap's value names, the field's name uppercased with underscores", () => {
    for (const [flag, shown] of [
      ["--db", "--db <DB>"],
      ["-d", "--db <DB>"],
      ["--interface", "--interface <INTERFACE>"],
      ["-i", "--interface <INTERFACE>"],
      ["--port", "--port <PORT>"],
      ["-p", "--port <PORT>"],
      ["--site-proxy-port", "--site-proxy-port <SITE_PROXY_PORT>"],
      ["--cloud-origin", "--cloud-origin <CLOUD_ORIGIN>"],
      ["--site-origin", "--site-origin <SITE_ORIGIN>"],
      ["--http-proxy", "--http-proxy <HTTP_PROXY>"],
      ["--deny-addresses", "--deny-addresses <DENY_ADDRESSES>"],
      ["--instance-name", "--instance-name <INSTANCE_NAME>"],
      ["--instance-secret", "--instance-secret <INSTANCE_SECRET>"],
      ["--local-storage", "--local-storage <LOCAL_STORAGE>"],
      ["--function-sandbox", "--function-sandbox <FUNCTION_SANDBOX>"],
    ]) {
      const possible = {
        "--db <DB>": "sqlite, postgres, mysql, mongodb",
        "--deny-addresses <DENY_ADDRESSES>": "none, metadata, private",
        "--function-sandbox <FUNCTION_SANDBOX>": "vm, process",
      }[shown!];
      const want = `error: a value is required for '${shown}' but none was supplied${possible ? `\n  [possible values: ${possible}]` : ""}\n\nFor more information, try '--help'.`;
      // At the end, before another flag, before `--`.
      expect(parseLocalBackendFlags(["--instance-secret", SECRET, flag!])).toBe(want);
      expect(parseLocalBackendFlags([flag!, "--do-not-require-ssl", "--instance-secret", SECRET])).toBe(want);
      expect(parseLocalBackendFlags([flag!, "--", "x"])).toBe(want);
    }
    // An empty value is no value for a list of values only.
    expect(parseLocalBackendFlags(["--db="])).toBe(
      "error: a value is required for '--db <DB>' but none was supplied\n  [possible values: sqlite, postgres, mysql, mongodb]\n\nFor more information, try '--help'.",
    );
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--local-storage="])).toMatchObject({
      localStorage: "",
    });
  });

  test("invalid values: clap's and Rust's reasons", () => {
    const bad = (args: string[]) => parseLocalBackendFlags(["--instance-secret", SECRET, ...args]);
    expect(bad(["--port", "nope"])).toBe(
      clap("invalid value 'nope' for '--port <PORT>': invalid digit found in string"),
    );
    expect(bad(["-pz"])).toBe(clap("invalid value 'z' for '--port <PORT>': invalid digit found in string"));
    expect(bad(["--port", "1e3"])).toBe(clap("invalid value '1e3' for '--port <PORT>': invalid digit found in string"));
    expect(bad(["--port="])).toBe(clap("invalid value '' for '--port <PORT>': cannot parse integer from empty string"));
    expect(bad(["--site-proxy-port", "70000"])).toBe(
      clap("invalid value '70000' for '--site-proxy-port <SITE_PROXY_PORT>': 70000 is not in 0..=65535"),
    );
    expect(bad(["--port=-1"])).toBe(clap("invalid value '-1' for '--port <PORT>': -1 is not in 0..=65535"));
    expect(bad(["--port", "99999999999999999999"])).toBe(
      clap("invalid value '99999999999999999999' for '--port <PORT>': number too large to fit in target type"),
    );
    expect(bad(["--port", "+5"])).toMatchObject({ port: 5 });
    expect(bad(["-p=4000"])).toMatchObject({ port: 4000 });
    expect(bad(["-p4000"])).toMatchObject({ port: 4000 });
    for (const v of ["localhost", "::", "01.2.3.4", "1.2.3", "256.1.1.1", ""])
      expect(bad([`--interface=${v}`])).toBe(
        clap(`invalid value '${v}' for '--interface <INTERFACE>': invalid IPv4 address syntax`),
      );
    expect(bad(["-i", "127.0.0.1"])).toMatchObject({ hostname: "127.0.0.1" });
    expect(bad(["--db", "postgresql"])).toBe(
      "error: invalid value 'postgresql' for '--db <DB>'\n  [possible values: sqlite, postgres, mysql, mongodb]\n\n  tip: a similar value exists: 'postgres'\n\nFor more information, try '--help'.",
    );
  });

  test("unknown arguments, repeated ones, `--`: clap's tips and usage lines", () => {
    expect(parseLocalBackendFlags(["-z"])).toBe(
      clap("unexpected argument '-z' found\n\n  tip: to pass '-z' as a value, use '-- -z'", HELP_USAGE),
    );
    // A negative number is a short flag, as clap reads it.
    expect(parseLocalBackendFlags(["--port", "-1"])).toBe(
      clap("unexpected argument '-1' found\n\n  tip: to pass '-1' as a value, use '-- -1'", HELP_USAGE),
    );
    expect(parseLocalBackendFlags(["--prot", "1"])).toBe(
      clap(
        "unexpected argument '--prot' found\n\n  tip: a similar argument exists: '--port'",
        "Usage: bunvex-local-backend <DB_SPEC|--db <DB>|--interface <INTERFACE>|--port <PORT>|--site-proxy-port <SITE_PROXY_PORT>|--cloud-origin <CLOUD_ORIGIN>|--site-origin <SITE_ORIGIN>|--http-proxy <HTTP_PROXY>|--deny-addresses <DENY_ADDRESSES>|--instance-name <INSTANCE_NAME>|--instance-secret <INSTANCE_SECRET>|--local-storage <LOCAL_STORAGE>|--s3-storage|--do-not-require-ssl|--redact-logs-to-client|--function-sandbox <FUNCTION_SANDBOX>>",
      ),
    );
    // bunvex's names suggest bunvex's flags (DV-197): Convex suggests `--site-proxy-port`, its `--convex-site` is far.
    expect(parseLocalBackendFlags(["--site", "1"])).toContain("tip: a similar argument exists: '--site-origin'");
    expect(parseLocalBackendFlags(["--function-sandbx", "vm"])).toContain(
      "tip: a similar argument exists: '--function-sandbox'",
    );
    expect(parseLocalBackendFlags(["a", "b"])).toBe(clap("unexpected argument 'b' found", HELP_USAGE));
    expect(parseLocalBackendFlags(["a", "kegen"])).toBe(
      clap("unrecognized subcommand 'kegen'\n\n  tip: a similar subcommand exists: 'keygen'", HELP_USAGE),
    );
    expect(parseLocalBackendFlags(["--port", "1", "-p", "2"])).toBe(
      clap("the argument '--port <PORT>' cannot be used multiple times", HELP_USAGE),
    );
    expect(parseLocalBackendFlags(["--s3-storage=1"])).toBe(
      clap(
        "unexpected value '1' for '--s3-storage' found; no more were expected",
        "Usage: bunvex-local-backend --s3-storage [DB_SPEC]",
      ),
    );
    // After `--`, a word that looks like a flag is the db_spec.
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--", "--bogus"])).toMatchObject({ dbSpec: "--bogus" });
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--port", "-"])).toBe(
      clap("invalid value '-' for '--port <PORT>': invalid digit found in string"),
    );
  });

  test("the program prints clap's message (exit 2), or Convex's `Error:` once the flags parse (exit 1)", async () => {
    const run = async (args: string[]) => {
      const r = io();
      return { code: await localBackendMain(args, r.it, "v1"), err: r.err.join("\n"), out: r.out.join("\n") };
    };
    expect(await run(["--function-sandbox"])).toEqual({
      code: 2,
      err: "error: a value is required for '--function-sandbox <FUNCTION_SANDBOX>' but none was supplied\n  [possible values: vm, process]\n\nFor more information, try '--help'.",
      out: "",
    });
    expect(await run([])).toEqual({
      code: 1,
      err: "Error: --instance-secret is required. Generate one with `openssl rand -hex 32`",
      out: "",
    });
    expect(await run(["--instance-secret", "zz"])).toEqual({ code: 1, err: "Error: Couldn't hexdecode key", out: "" });
    // clap acts on --help and --version where they come: a mistake before them wins.
    expect((await run(["--port", "1", "--help", "--bogus"])).code).toBe(0);
    expect((await run(["--bogus", "--help"])).code).toBe(2);
    expect(await run(["--port", "1", "-V"])).toEqual({ code: 0, err: "", out: "bunvex-local-backend v1" });
    expect((await run(["help"])).out).toStartWith("The bunvex backend.\n\nUsage: bunvex-local-backend [OPTIONS]");
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
    expect(await localBackendMain([], bad.it, "v1")).toBe(1);
    expect(bad.err[0]).toStartWith("Error: --instance-secret is required.");
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

  // As Convex's binary reads it (STUDY-172 §7): `const_hex::decode` drops one `0x` / `0X`.
  test("a 0x-prefixed secret: accepted as Convex's, refused with its messages otherwise", () => {
    for (const s of [`0x${SECRET}`, `0X${SECRET}`, `0x${"aB".repeat(32)}`]) expect(instanceSecretError(s)).toBeNull();
    for (const [s, message] of [
      [`0x0x${SECRET}`, "Couldn't hexdecode key"],
      [`x${SECRET}`, "Couldn't hexdecode key"],
      [`0x${SECRET}a`, "Couldn't hexdecode key"],
      [`0x${SECRET.slice(1)}`, "Couldn't hexdecode key"],
      ["0x", "Hex-decoded key was 0 bytes, not 32"],
      ["0xab", "Hex-decoded key was 1 bytes, not 32"],
    ])
      expect(instanceSecretError(s!)).toBe(message!);
    expect(refused(["--instance-secret", `0x${SECRET}`])).toBeNull();
    expect(refused([], { INSTANCE_SECRET: `0X${SECRET}` })).toBeNull();
    expect(refused([], { INSTANCE_SECRET: `0x0x${SECRET}` })).toBe("Couldn't hexdecode key");
  });

  test("keys are interchangeable across a secret's spellings (0x, 0X, case): the same 32 bytes", async () => {
    const keygen = async (secret: string, env: Record<string, string> = {}) => {
      const k = io();
      const args = ["keygen", "admin-key", "--instance-name", "bunvex-self-hosted"];
      expect(
        await localBackendMain(secret ? [...args, "--instance-secret", secret] : args, { ...k.it, env }, "v"),
      ).toBe(0);
      return k.out[0]!;
    };
    const keys = [
      await keygen(SECRET),
      await keygen(`0x${SECRET}`),
      await keygen(`0X${SECRET.toUpperCase()}`),
      await keygen("", { INSTANCE_SECRET: `0x${SECRET}` }),
    ];
    const other = await keygen("cd".repeat(32));
    for (const key of keys) expect(checkAdminKey(key, "bunvex-self-hosted", adminKeyCipherKey(SECRET))).toBeTruthy();
    const cwd = mkdtempSync(join(tmpdir(), "bunvex-lb-"));
    dirs.push(cwd);
    // The same store started under each spelling in turn: every key is the deployment's, another secret's is not.
    for (const secret of [`0x${SECRET}`, SECRET, `0X${SECRET.toUpperCase()}`]) {
      const flags = parseLocalBackendFlags(["--instance-secret", secret, "--port", "0", "--site-proxy-port", "0"]);
      if (typeof flags === "string") throw new Error(flags);
      const b = await startLocalBackend(flags, io(cwd).it);
      const check = (key: string) =>
        fetch(`${b.url}/api/check_admin_key`, { headers: { authorization: `Bunvex ${key}` } }).then((r) => r.status);
      try {
        for (const key of keys) expect(await check(key)).toBe(200);
        expect(await check(other)).toBe(401);
      } finally {
        await b.stop();
      }
    }
  });

  test("--help; keygen's usage errors exit 2 with Convex's messages", async () => {
    const h = io();
    expect(await localBackendMain(["--port", "1", "--help"], h.it, "v1")).toBe(0);
    expect(h.out[0]).toContain("-h, --help");
    const run = async (args: string[]) => {
      const r = io();
      return { code: await localBackendMain(["keygen", ...args], r.it, "v1"), err: r.err.join("\n") };
    };
    const ADMIN_USAGE =
      "Usage: bunvex-local-backend keygen admin-key --instance-name <INSTANCE_NAME> --instance-secret <INSTANCE_SECRET>";
    expect(await run(["other"])).toEqual({
      code: 2,
      err: clap("unrecognized subcommand 'other'", "Usage: bunvex-local-backend keygen <COMMAND>"),
    });
    expect((await run([])).code).toBe(2);
    expect((await run([])).err).toStartWith("Generate keys without starting the server\n\nUsage:");
    expect(await run(["admin-key", "--instance-name", "n", "--bogus"])).toEqual({
      code: 2,
      err: clap(
        "unexpected argument '--bogus' found",
        "Usage: bunvex-local-backend keygen admin-key <--instance-name <INSTANCE_NAME>|--instance-secret <INSTANCE_SECRET>>",
      ),
    });
    expect(await run(["admin-key", "--instance-name", "n"])).toEqual({
      code: 2,
      err: clap(
        "the following required arguments were not provided:\n  --instance-secret <INSTANCE_SECRET>",
        ADMIN_USAGE,
      ),
    });
    expect(await run(["admin-key", "--instance-name"])).toEqual({
      code: 2,
      err: clap("a value is required for '--instance-name <INSTANCE_NAME>' but none was supplied"),
    });
    expect(await run(["admin-key", "--instance-name", "n", "--instance-secret", "xyz"])).toEqual({
      code: 1,
      err: "Error: Couldn't hexdecode key",
    });
  });

  // As Convex's binary answers them (STUDY-172 §1.2): the helps on stdout, exit 0; an unknown subcommand, exit 2.
  test("help and keygen help: the helps of each command, clap's error for an unknown one", async () => {
    const run = async (args: string[]) => {
      const r = io();
      return { code: await localBackendMain(args, r.it, "v1"), out: r.out.join("\n"), err: r.err.join("\n") };
    };
    for (const [args, help] of [
      [["help"], LOCAL_BACKEND_USAGE],
      [["help", "keygen"], KEYGEN_USAGE],
      [["help", "keygen", "admin-key"], ADMIN_KEY_USAGE],
      [["keygen", "help"], KEYGEN_USAGE],
      [["keygen", "-h"], KEYGEN_USAGE],
      [["keygen", "--help"], KEYGEN_USAGE],
      [["keygen", "help", "admin-key"], ADMIN_KEY_USAGE],
      [["keygen", "admin-key", "-h"], ADMIN_KEY_USAGE],
      [["keygen", "admin-key", "--instance-name", "n", "--help"], ADMIN_KEY_USAGE],
    ] as const)
      expect(await run([...args])).toEqual({ code: 0, out: help, err: "" });
    expect(await run(["help", "foo"])).toEqual({
      code: 2,
      out: "",
      err: clap("unrecognized subcommand 'foo'", HELP_USAGE),
    });
    expect(await run(["keygen", "help", "foo"])).toEqual({
      code: 2,
      out: "",
      err: clap("unrecognized subcommand 'foo'", "Usage: bunvex-local-backend keygen <COMMAND>"),
    });
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
      expect(refused([], env)).toBe("--instance-secret is required. Generate one with `openssl rand -hex 32`");
      expect(parseLocalBackendFlags(["--instance-name", "x"], env)).toStartWith(
        "error: the following required arguments were not provided:\n  --instance-secret <INSTANCE_SECRET>\n",
      );
    }
    // The variable's value is checked as the flag's.
    expect(refused([], { INSTANCE_SECRET: "abcd" })).toBe("Hex-decoded key was 2 bytes, not 32");
    expect(refused([], { INSTANCE_SECRET: "xyz" })).toBe("Couldn't hexdecode key");
    // Not read from the process unless given.
    process.env.INSTANCE_SECRET = SECRET;
    try {
      expect(refused([])).toBe("--instance-secret is required. Generate one with `openssl rand -hex 32`");
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
      err: clap(
        "the following required arguments were not provided:\n  --instance-secret <INSTANCE_SECRET>",
        "Usage: bunvex-local-backend keygen admin-key --instance-name <INSTANCE_NAME> --instance-secret <INSTANCE_SECRET>",
      ),
    });
    expect((await keygen([], { INSTANCE_SECRET: "xyz" })).err).toBe("Error: Couldn't hexdecode key");
  });

  test("the program takes INSTANCE_SECRET from its environment and removes it there (DV-525)", async () => {
    const r = io();
    const env: Record<string, string | undefined> = { INSTANCE_SECRET: SECRET, OTHER: "kept" };
    const args = ["--db", "postgres", "postgres://u@127.0.0.1:1"];
    // Past the flags (the secret was found) to the start, which fails on the connection.
    expect(await localBackendMain(args, { ...r.it, env }, "v1")).toBe(1);
    expect(r.err).toEqual([expect.stringMatching(/^Error: (?!--instance-secret)/)]);
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
    expect(r.err).toEqual([expect.stringMatching(/^Error: /)]);
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
