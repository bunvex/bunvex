// Whether an AI agent is running the CLI, from the variables agents set in their shells (DV-551): Convex's
// `detectAiAgent` (cli/lib/utils/aiAgent.ts, 7550fdd) asks `@vercel/detect-agent` and its own `CONVEX_AGENT_MODE`;
// bunvex keeps its own list, with no dependency, and reads `BUNVEX_AGENT_MODE` first. The names are the ones that
// package reports, so `env list`'s note names an agent as Convex's does. Its one check that is not a variable (a
// Devin file, `/opt/.devin`) is left out.
import type { Io } from "./io.ts";

/** Each agent, by the variables it sets: the first whose test holds names it. */
const AGENTS: [name: string | ((env: Io["env"]) => string), test: (env: Io["env"]) => boolean][] = [
  ["cursor", (e) => !!e.CURSOR_TRACE_ID],
  ["cursor-cli", (e) => !!e.CURSOR_AGENT || e.CURSOR_EXTENSION_HOST_ROLE === "agent-exec"],
  ["gemini", (e) => !!e.GEMINI_CLI],
  ["codex", (e) => !!(e.CODEX_SANDBOX || e.CODEX_CI || e.CODEX_THREAD_ID)],
  ["antigravity", (e) => !!e.ANTIGRAVITY_AGENT],
  ["augment-cli", (e) => !!e.AUGMENT_AGENT],
  ["opencode", (e) => !!e.OPENCODE_CLIENT],
  [(e) => (e.CLAUDE_CODE_IS_COWORK ? "cowork" : "claude"), (e) => !!(e.CLAUDECODE || e.CLAUDE_CODE)],
  ["replit", (e) => !!e.REPL_ID],
  ["github-copilot", (e) => !!(e.COPILOT_MODEL || e.COPILOT_ALLOW_ALL || e.COPILOT_GITHUB_TOKEN)],
];

/**
 * The name of the AI agent running this process, or null: `BUNVEX_AGENT_MODE` (bunvex's own), else `AI_AGENT`'s
 * value (the cross-tool convention; GitHub Copilot's CLI named as Copilot), else the first agent whose variables are
 * set.
 */
export function detectAgent(env: Io["env"]): string | null {
  if (env.BUNVEX_AGENT_MODE) return "BUNVEX_AGENT_MODE";
  const declared = env.AI_AGENT?.trim();
  if (declared) return declared === "github-copilot-cli" ? "github-copilot" : declared;
  for (const [name, test] of AGENTS) if (test(env)) return typeof name === "string" ? name : name(env);
  return null;
}
