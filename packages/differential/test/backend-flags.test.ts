// The backend's command line (STUDY-172): the same mistakes given to Convex's `convex-local-backend` (the oracle)
// and to `bunvex-local-backend`, their stderr and exit codes compared. clap writes Convex's; bunvex's parser
// (`server/src/command-line.ts`) follows its rules. Convex's text is read in bunvex's names first: the flags
// DV-197 renames, the `--db` values, and the derive's group of every argument (Convex's has its hidden flags).
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN). Cases where bunvex's flags differ from Convex's by decision (`--instance-secret` without
// `--instance-name`, DV-197's default name) are in server/test/local-backend.test.ts instead.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBackendMain } from "bunvex/server";
import { ORACLE_BIN } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`backend-flags: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const SECRET = "ab".repeat(32);
const cwd = mkdtempSync(join(tmpdir(), "bunvex-flags-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const CONVEX_GROUP =
  "<DB_SPEC|--db <DB>|--interface <INTERFACE>|--port <PORT>|--site-proxy-port <SITE_PROXY_PORT>|--convex-origin <CONVEX_ORIGIN>|--convex-site <CONVEX_SITE>|--convex-http-proxy <CONVEX_HTTP_PROXY>|--instance-name <INSTANCE_NAME>|--instance-secret <INSTANCE_SECRET>|--control-plane-access-token <CONTROL_PLANE_ACCESS_TOKEN>|--control-plane-url <CONTROL_PLANE_URL>|--sentry-identifier <SENTRY_IDENTIFIER>|--local-storage <LOCAL_STORAGE>|--s3-storage|--do-not-require-ssl|--disable-beacon|--beacon-tag <BEACON_TAG>|--beacon-fields <BEACON_FIELDS>|--redact-logs-to-client|--local-log-sink <LOCAL_LOG_SINK>>";
const BUNVEX_GROUP =
  "<DB_SPEC|--db <DB>|--interface <INTERFACE>|--port <PORT>|--site-proxy-port <SITE_PROXY_PORT>|--cloud-origin <CLOUD_ORIGIN>|--site-origin <SITE_ORIGIN>|--http-proxy <HTTP_PROXY>|--deny-addresses <DENY_ADDRESSES>|--instance-name <INSTANCE_NAME>|--instance-secret <INSTANCE_SECRET>|--local-storage <LOCAL_STORAGE>|--s3-storage|--do-not-require-ssl|--redact-logs-to-client|--function-sandbox <FUNCTION_SANDBOX>>";

/** Convex's words in bunvex's names (DV-197). */
const inBunvexNames = (text: string) =>
  text
    .replaceAll(CONVEX_GROUP, BUNVEX_GROUP)
    .replaceAll("convex-local-backend", "bunvex-local-backend")
    .replaceAll("convex-origin", "cloud-origin")
    .replaceAll("CONVEX_ORIGIN", "CLOUD_ORIGIN")
    .replaceAll("convex-site", "site-origin")
    .replaceAll("CONVEX_SITE", "SITE_ORIGIN")
    .replaceAll("convex-http-proxy", "http-proxy")
    .replaceAll("CONVEX_HTTP_PROXY", "HTTP_PROXY")
    .replaceAll(
      "[possible values: sqlite, mysql-v5, mysql-v5-multitenant, mysql-v6-multitenant, postgres-v5]",
      "[possible values: sqlite, postgres, mysql, mongodb]",
    );
/** bunvex's argv in Convex's names. */
const inConvexNames = (args: string[]) =>
  args.map((a) =>
    a
      .replace(/^--cloud-origin/, "--convex-origin")
      .replace(/^--site-origin/, "--convex-site")
      .replace(/^--http-proxy/, "--convex-http-proxy"),
  );

function convex(args: string[]) {
  const r = Bun.spawnSync([ORACLE_BIN, ...inConvexNames(args)], {
    cwd,
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
  return {
    code: r.exitCode,
    out: inBunvexNames(r.stdout.toString().trimEnd()),
    err: inBunvexNames(r.stderr.toString().trimEnd()),
  };
}
async function bunvex(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await localBackendMain(args, { env: {}, cwd, out: (l) => out.push(l), err: (l) => err.push(l) }, "v");
  return { code, out: out.join("\n").trimEnd(), err: err.join("\n").trimEnd() };
}

// Every one is refused before a backend starts, by both.
const CASES: string[][] = [
  // A value missing: each option of both, at the end, before a flag, before `--`, empty after `=`.
  ...["--db", "-d", "--interface", "-i", "--port", "-p", "--site-proxy-port"].map((f) => [f]),
  ...["--cloud-origin", "--site-origin", "--http-proxy", "--instance-name", "--instance-secret", "--local-storage"].map(
    (f) => [f],
  ),
  ["--db", "--port", "1"],
  ["--port", "--"],
  ["--db="],
  ["--port", "1", "--port"],
  // Invalid values.
  ["--db", "nope"],
  ["--db", "SQLITE"],
  ["--db", "sqlit"],
  ["--db=sqlite3"],
  ["--port", "nope"],
  ["--port", "70000"],
  ["--port=-1"],
  ["--port="],
  ["--port", "1e3"],
  ["--port", "0x10"],
  ["--port", "-"],
  ["--port", "99999999999999999999"],
  ["-pz"],
  ["-pp"],
  ["--site-proxy-port", "65536"],
  ["--interface", "localhost"],
  ["--interface", "01.2.3.4"],
  ["--interface", "1.2.3"],
  ["--interface", "256.1.1.1"],
  ["--interface", "::"],
  ["--interface="],
  ["--http-proxy", "nope"],
  ["--http-proxy="],
  ["--port", "x", "--db", "sqlite"],
  // Unknown arguments, suggestions, `--`.
  ["--bogus"],
  ["--bogus=1"],
  ["-z"],
  ["-x"],
  ["--port", "-1"],
  ["--instance-name", "-x"],
  ["--instance-name", "--bogus"],
  ["-p4000", "--bogus"],
  ["-p=4000", "--bogus"],
  ["--port", "x", "--bogus"],
  ["--db", "nope", "--bogus"],
  ["--bogus", "--db", "nope"],
  ["--prot", "1"],
  ["--po", "1"],
  ["--p", "1"],
  ["--interfac", "1"],
  ["--db-spec", "x"],
  ["--redact"],
  ["--ssl"],
  ["--local", "x"],
  ["--s3", "x"],
  ["--hel"],
  ["--versio"],
  ["a", "b"],
  ["a", "kegen"],
  ["a", "y"],
  ["a", "--", "b"],
  ["a", "--", "kegen"],
  ["--", "a", "b"],
  // A flag with a value; twice.
  ["--s3-storage=1"],
  ["--s3-storage="],
  ["--port=1", "--s3-storage=x"],
  ["--port", "1", "--s3-storage=x"],
  ["--port", "1", "--port", "2"],
  ["--port", "1", "-p", "2"],
  ["--port", "1", "--port", "x"],
  ["--s3-storage", "--s3-storage"],
  ["--instance-name", "x", "--instance-name", "y"],
  // Conflicts and requirements.
  ["--s3-storage", "--local-storage", "x"],
  ["--local-storage", "x", "--s3-storage"],
  ["--port", "1", "--s3-storage", "--db", "sqlite", "--local-storage", "x"],
  ["--s3-storage", "--local-storage", "x", "--port", "1"],
  ["--port", "1", "--local-storage", "y", "--s3-storage"],
  ["--cloud-origin", "x"],
  ["--site-origin", "x"],
  ["--port", "1", "--cloud-origin", "x"],
  ["x", "--instance-name=a", "--instance-secret=b", "--local-storage", "y", "--s3-storage"],
  // Refused once parsed (Convex's `Error:`, exit 1).
  [],
  ["--instance-name", "x", "--instance-secret", "abcd"],
  ["--instance-name", "x", "--instance-secret", "zz"],
  ["--instance-name", "x", "--instance-secret", "abc"],
  // keygen.
  ["keygen"],
  ["keygen", "other"],
  ["keygen", "-x"],
  ["keygen", "admin-key"],
  ["keygen", "admin-key", "--instance-name", "n"],
  ["keygen", "admin-key", "--instance-name"],
  ["keygen", "admin-key", "--instance-name="],
  ["keygen", "admin-key", "--instance-name", "n", "--bogus"],
  ["keygen", "admin-key", "--instance-nam", "a"],
  ["keygen", "admin-key", "-x"],
  ["keygen", "admin-key", "x"],
  ["keygen", "admin-key", "--instance-name", "a", "--instance-name", "b"],
  ["keygen", "admin-key", "--instance-name", "n", "--instance-secret", "xyz"],
  ["keygen", "admin-key", "--instance-name", "n", "--instance-secret", "abcd"],
  ["help", "foo"],
  ["keygen", "help", "foo"],
];

describe.skipIf(!ready)("the backend's command-line errors on Convex and on bunvex", () => {
  for (const args of CASES)
    test(JSON.stringify(args), async () => {
      const c = convex(args);
      const b = await bunvex(args);
      // Convex's keygen logs its error first (`report_error`); the message is the last line.
      const last = (s: string) => (c.code === 1 ? s.split("\n").at(-1)! : s);
      expect({ code: b.code, err: last(b.err) }).toEqual({ code: c.code, err: last(c.err) });
    });

  test("help and version exit 0; keygen's help is clap's", async () => {
    for (const args of [
      ["keygen", "admin-key", "--instance-name", "n", "--instance-secret", SECRET],
      ["keygen", "--help"],
      ["keygen", "help", "admin-key"],
      ["help"],
      ["--port", "1", "--help"],
      ["-V"],
    ])
      expect((await bunvex(args)).code).toBe(convex(args).code);
    for (const args of [
      ["keygen", "--help"],
      ["keygen", "-h"],
      ["keygen", "help"],
      ["help", "keygen"],
    ])
      expect((await bunvex(args)).out).toBe(convex(args).out);
    // Bare `keygen`: its help as the error.
    expect((await bunvex(["keygen"])).err).toBe(convex(["keygen"]).err);
    // admin-key's names INSTANCE_SECRET (DV-525); the rest is clap's.
    expect((await bunvex(["keygen", "admin-key", "--help"])).out).toBe(
      convex(["keygen", "admin-key", "--help"]).out.replace(
        "Instance secret for this backend",
        "Instance secret for this backend [env: INSTANCE_SECRET]",
      ),
    );
  });
});
