// `env list`'s values (Convex's 5a633b4 and 7550fdd; STUDY-186 A16, DV-551), with each backend's own CLI (Convex's
// `convex` 1.48.0, bunvex's) against its own backend: the values by default and with `--include-values`, its conflict
// with `--names-only`, and names only, with a note on stderr, when the environment says an AI agent runs it.
// Compared: the exit code, stdout, and the note. `CONVEX_AGENT_MODE` / `BUNVEX_AGENT_MODE` are each CLI's own
// (DV-551), checked on each. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`env-list-values: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  for (const b of [convex, bunvex]) {
    await b.cli(["env", "set", "API_KEY", "secret"]);
    await b.cli(["env", "set", "MODE", "prod"]);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** No agent: every variable an agent sets (in the shell running these tests too), removed. */
const HUMAN: Record<string, undefined> = Object.fromEntries(
  [
    "AI_AGENT",
    "BUNVEX_AGENT_MODE",
    "CONVEX_AGENT_MODE",
    "CURSOR_TRACE_ID",
    "CURSOR_AGENT",
    "CURSOR_EXTENSION_HOST_ROLE",
    "GEMINI_CLI",
    "CODEX_SANDBOX",
    "CODEX_CI",
    "CODEX_THREAD_ID",
    "ANTIGRAVITY_AGENT",
    "AUGMENT_AGENT",
    "OPENCODE_CLIENT",
    "CLAUDECODE",
    "CLAUDE_CODE",
    "CLAUDE_CODE_IS_COWORK",
    "REPL_ID",
    "COPILOT_MODEL",
    "COPILOT_ALLOW_ALL",
    "COPILOT_GITHUB_TOKEN",
  ].map((k) => [k, undefined]),
);

const NOTE =
  /^Listed names only because an AI agent \((.+)\) appears to be running this command\. Pass --include-values to print the values too\.$/m;

async function seen(b: Backend, args: string[], env: Record<string, string> = {}) {
  const r = await b.cliOutput(["env", "list", ...args], { ...HUMAN, ...env });
  return { code: r.code, out: r.out.trim().split("\n"), agent: NOTE.exec(r.err)?.[1] ?? null, err: r.err };
}

async function same(args: string[], env: Record<string, string> = {}) {
  const c = await seen(convex, args, env);
  const b = await seen(bunvex, args, env);
  expect({ args, env, code: b.code, out: b.out, agent: b.agent }).toEqual({
    args,
    env,
    code: c.code,
    out: c.out,
    agent: c.agent,
  });
  return c;
}

const VALUES = ["API_KEY=secret", "MODE=prod"];
const NAMES = ["API_KEY", "MODE"];

describe.skipIf(!ready)("env list's values, against Convex's CLI and backend", () => {
  test("a person: values, with or without --include-values; names with --names-only", async () => {
    expect((await same([])).out).toEqual(VALUES);
    expect((await same(["--include-values"])).out).toEqual(VALUES);
    expect((await same(["--names-only"])).out).toEqual(NAMES);
  });

  test("--include-values and --names-only conflict, as commander reports it", async () => {
    const c = await same(["--names-only", "--include-values"]);
    expect(c.code).toBe(1);
    expect(c.err.trim()).toBe("error: option '--include-values' cannot be used with option '--names-only'");
    expect((await seen(bunvex, ["--names-only", "--include-values"])).err.trim()).toBe(c.err.trim());
  });

  test("an agent: names and the note naming it, unless it asks for the values", async () => {
    for (const env of <Record<string, string>[]>[
      { AI_AGENT: "claude-code_2-1-299_agent" },
      { CLAUDECODE: "1" },
      { CLAUDECODE: "1", CLAUDE_CODE_IS_COWORK: "1" },
      { CODEX_SANDBOX: "seatbelt" },
      { CURSOR_TRACE_ID: "t" },
      { AI_AGENT: "github-copilot-cli" },
      { COPILOT_MODEL: "m" },
    ]) {
      const c = await same([], env);
      expect({ env, out: c.out, named: c.agent !== null }).toEqual({ env, out: NAMES, named: true });
      expect((await same(["--include-values"], env)).out).toEqual(VALUES);
      expect((await same(["--names-only"], env)).agent).toBeNull();
    }
  });

  test("each CLI's own agent-mode variable (DV-551)", async () => {
    expect((await seen(convex, [], { CONVEX_AGENT_MODE: "anonymous" })).agent).toBe("CONVEX_AGENT_MODE");
    expect((await seen(bunvex, [], { BUNVEX_AGENT_MODE: "anonymous" })).agent).toBe("BUNVEX_AGENT_MODE");
    expect((await seen(bunvex, [], { CONVEX_AGENT_MODE: "anonymous" })).out).toEqual(VALUES);
  });
});
