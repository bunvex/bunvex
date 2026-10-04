// `bunvex env` end to end (STUDY-37 PR 2) against a running deployable server: Convex's forms, value
// sources, messages (stdout vs stderr) and exit codes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { formatEnvValueForDotfile } from "../src/env.ts";
import { type Io, main } from "../src/index.ts";

const SECRET = "ef".repeat(32);
const NAME = "env-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-env-"));
  dirs.push(d);
  return d;
};

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
    moduleStorage: null as never,
  });
  stops.push(() => s.shutdown());
  return `http://127.0.0.1:${s.server.port}`;
}

function cli(cwd: string, url: string, o: { stdin?: string | null; prompt?: string | null; key?: string } = {}) {
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const it: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: url, BUNVEX_SELF_HOSTED_ADMIN_KEY: o.key ?? KEY },
      cwd,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdin: async () => o.stdin ?? null,
      prompt: () => o.prompt ?? null,
    };
    const code = await main(["env", ...args], it);
    return { code, out, err };
  };
  return run;
}

describe("bunvex env", () => {
  test("set (both forms), get, list, remove: Convex's output and exit codes", async () => {
    const url = await deployment();
    const env = cli(tmp(), url);
    expect(await env("list")).toEqual({ code: 0, out: [], err: ["No environment variables set"] });
    expect(await env("set", "API_KEY", "secret value")).toEqual({
      code: 0,
      out: [],
      err: ["✔ Successfully set API_KEY"],
    });
    expect((await env("set", "MODE=prod")).err).toEqual(["✔ Successfully set MODE"]);
    expect((await env("set", "MODE=prod", "extra")).code).toBe(1);
    expect(await env("get", "API_KEY")).toEqual({ code: 0, out: ["secret value"], err: [] });
    // A missing variable: on stderr, and still 0.
    expect(await env("get", "NOPE")).toEqual({ code: 0, out: [], err: ['✖ Environment variable "NOPE" not found'] });
    expect((await env("list")).out).toEqual(["API_KEY=secret value", "MODE=prod"]);
    expect((await env("list", "--names-only")).out).toEqual(["API_KEY", "MODE"]);
    expect(await env("rm", "MODE")).toEqual({ code: 0, out: [], err: ["✔ Successfully unset MODE"] });
    expect((await env("unset", "NEVER_SET")).code).toBe(0); // as Convex: unsetting a missing one succeeds
    expect((await env("remove", "API_KEY")).code).toBe(0);
    expect((await env("list")).err).toEqual(["No environment variables set"]);
    // The deployment's errors come through, with exit code 1.
    const bad = await env("set", "9BAD", "x");
    expect(bad.code).toBe(1);
    expect(bad.err[0]).toContain("The environment variable name 9BAD is invalid.");
  });

  test("value sources: --from-file, piped stdin, a prompt", async () => {
    const url = await deployment();
    const dir = tmp();
    writeFileSync(join(dir, "cert.pem"), "line 1\nline 2");
    expect((await cli(dir, url)("set", "CERT", "--from-file", "cert.pem")).code).toBe(0);
    expect((await cli(dir, url, { stdin: "from a pipe" })("set", "PIPED")).code).toBe(0);
    expect((await cli(dir, url, { prompt: "typed" })("set", "TYPED")).code).toBe(0);
    expect((await cli(dir, url)("list")).out).toEqual(["CERT='line 1\nline 2'", "PIPED=from a pipe", "TYPED=typed"]);
    expect(await cli(dir, url)("set", "X", "--from-file", "missing.txt")).toMatchObject({
      code: 1,
      err: ["error: file not found: missing.txt"],
    });
  });

  test("many from a .env file or stdin: new, unchanged, conflicts, --force, CLI-managed names skipped", async () => {
    const url = await deployment();
    const dir = tmp();
    writeFileSync(
      join(dir, ".env.defaults"),
      "A=1\nB=2\nBUNVEX_SELF_HOSTED_URL=http://x\nVITE_BUNVEX_URL=http://y\n# a comment\n",
    );
    const first = await cli(dir, url)("set", "--from-file", ".env.defaults");
    expect(first).toEqual({
      code: 0,
      out: [],
      err: [
        "Skipping 2 CLI-managed environment variables: BUNVEX_SELF_HOSTED_URL and VITE_BUNVEX_URL",
        "✔ Successfully set 2 environment variables from .env.defaults (2 new)",
      ],
    });
    const again = await cli(dir, url, { stdin: "A=1\nB=2\n" })("set");
    expect(again.err).toEqual(["All 2 environment variables from stdin already set"]);
    const conflict = await cli(dir, url, { stdin: "A=1\nB=3\nC=4\n" })("set");
    expect(conflict).toEqual({
      code: 1,
      out: [],
      err: [
        "error: environment variable B already exists with different value.\n\nUse --force to overwrite existing values.",
      ],
    });
    expect((await cli(dir, url)("list")).out).toEqual(["A=1", "B=2"]); // nothing changed
    const forced = await cli(dir, url, { stdin: "A=1\nB=3\nC=4\n" })("set", "--force");
    expect(forced.err).toEqual([
      "✔ Successfully set 2 environment variables from stdin (1 new, 1 updated, 1 unchanged)",
    ]);
    expect((await cli(dir, url, { stdin: "" })("set")).err).toEqual(["No environment variables found in stdin."]);
    // Nothing to set, on a terminal: the usage, and an error.
    const none = await cli(dir, url)("set");
    expect(none.code).toBe(1);
    expect(none.err.at(-1)).toBe("error: No environment variables specified to be set.");
  });

  test("what list prints, set reads back: multi-line values survive a round trip through a .env file", async () => {
    const url = await deployment();
    const dir = tmp();
    const values: Record<string, string> = {
      CERT: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      QUOTED: "it's\nmulti",
      HASH: "a#b",
      JSON: '{"a":"b"}',
    };
    for (const [name, value] of Object.entries(values)) {
      writeFileSync(join(dir, name), value);
      expect((await cli(dir, url)("set", name, "--from-file", name)).code).toBe(0);
    }
    const listed = (await cli(dir, url)("list")).out.join("\n");
    // A second deployment, filled from the first one's listing.
    const other = await deployment();
    writeFileSync(join(dir, ".env.copy"), listed);
    expect((await cli(dir, other)("set", "--from-file", ".env.copy")).code).toBe(0);
    for (const [name, value] of Object.entries(values))
      expect((await cli(dir, other)("get", name)).out).toEqual([value]);
  });

  test("access: a read-only key reads but cannot write; no deployment configured", async () => {
    const url = await deployment();
    const dir = tmp();
    expect((await cli(dir, url)("set", "A", "1")).code).toBe(0);
    const ro = cli(dir, url, { key: READ_ONLY });
    expect((await ro("get", "A")).out).toEqual(["1"]);
    expect((await ro("set", "A", "2")).code).toBe(1);
    const err: string[] = [];
    expect(await main(["env", "list"], { env: {}, cwd: dir, out: () => {}, err: (l) => err.push(l) })).toBe(1);
    // Convex's message, pointing to `bunvex dev` (which creates the project's local deployment).
    expect(err[0]).toBe("bunvex env: No BUNVEX_DEPLOYMENT set, run `bunvex dev` to configure a bunvex project");
  });

  test("list quotes values as a .env file needs them (Convex's formatEnvValueForDotfile)", () => {
    expect(formatEnvValueForDotfile("plain")).toEqual({ formatted: "plain" });
    expect(formatEnvValueForDotfile("a\nb")).toEqual({ formatted: "'a\nb'" });
    expect(formatEnvValueForDotfile("it's\nhere")).toEqual({ formatted: '"it\'s\\nhere"' });
    expect(formatEnvValueForDotfile('"quoted"')).toEqual({ formatted: `'"quoted"'` });
    expect(formatEnvValueForDotfile("a#b").formatted).toBe("'a#b'");
    expect(formatEnvValueForDotfile("it's #1")).toMatchObject({ formatted: `"it's #1"` });
    expect(formatEnvValueForDotfile("x\ry").warning).toContain("carriage return");
  });
});
