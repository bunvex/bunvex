// bunvex's detection of an AI agent (DV-551): `BUNVEX_AGENT_MODE`, then `AI_AGENT`, then each agent's own variables,
// named as `@vercel/detect-agent` 1.2.5 names them (Convex's `detectAiAgent`, 7550fdd), so `env list`'s note reads
// the same.
import { expect, test } from "bun:test";
import { detectAgent } from "../src/agent.ts";

test("each agent by its variables; none in a plain shell", () => {
  const cases: [Record<string, string>, string | null][] = [
    [{}, null],
    [{ HOME: "/home/x", TERM: "xterm" }, null],
    [{ CONVEX_AGENT_MODE: "anonymous" }, null],
    [{ AI_AGENT: "   " }, null],
    [{ BUNVEX_AGENT_MODE: "anonymous", AI_AGENT: "x" }, "BUNVEX_AGENT_MODE"],
    [{ AI_AGENT: " claude-code_2-1-299_agent ", CLAUDECODE: "1" }, "claude-code_2-1-299_agent"],
    [{ AI_AGENT: "github-copilot-cli" }, "github-copilot"],
    [{ AI_AGENT: "v0" }, "v0"],
    [{ CURSOR_TRACE_ID: "t" }, "cursor"],
    [{ CURSOR_AGENT: "1" }, "cursor-cli"],
    [{ CURSOR_EXTENSION_HOST_ROLE: "agent-exec" }, "cursor-cli"],
    [{ CURSOR_EXTENSION_HOST_ROLE: "user" }, null],
    [{ GEMINI_CLI: "1" }, "gemini"],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex"],
    [{ CODEX_CI: "1" }, "codex"],
    [{ CODEX_THREAD_ID: "t" }, "codex"],
    [{ ANTIGRAVITY_AGENT: "1" }, "antigravity"],
    [{ AUGMENT_AGENT: "1" }, "augment-cli"],
    [{ OPENCODE_CLIENT: "1" }, "opencode"],
    [{ CLAUDECODE: "1" }, "claude"],
    [{ CLAUDE_CODE: "1" }, "claude"],
    [{ CLAUDECODE: "1", CLAUDE_CODE_IS_COWORK: "1" }, "cowork"],
    [{ REPL_ID: "r" }, "replit"],
    [{ COPILOT_MODEL: "m" }, "github-copilot"],
    [{ COPILOT_ALLOW_ALL: "1" }, "github-copilot"],
    [{ COPILOT_GITHUB_TOKEN: "t" }, "github-copilot"],
    // The first match wins, in the package's order.
    [{ REPL_ID: "r", CURSOR_TRACE_ID: "t" }, "cursor"],
    [{ CLAUDECODE: "1", GEMINI_CLI: "1" }, "gemini"],
  ];
  for (const [env, agent] of cases) expect({ env, agent: detectAgent(env) }).toEqual({ env, agent });
});
