// The mock's environment variables (UI-01 §14.4): a few to start with, and Convex's batch update — all
// changes or none, each checked with the same rules the screen shows (settings/env-vars.ts).
import { DataSourceError, type EnvironmentVariable, type EnvironmentVariableChange } from "../data-source.ts";
import { nameProblem, setProblem, valueProblem } from "../settings/env-vars.ts";

const SAMPLE: EnvironmentVariable[] = [
  { name: "AUTH_SECRET", value: "s3cr3t-7f2c9a1e44b0d86f" },
  { name: "LOG_LEVEL", value: "info" },
  { name: "OPENAI_API_KEY", value: "sk-mock-0000000000000000000000000000" },
  { name: "RESEND_API_KEY", value: "re_mock_12345" },
  { name: "SITE_URL", value: "http://localhost:5173" },
];

export class MockEnvironmentVariables {
  private vars = new Map<string, string>();

  constructor(sample = true) {
    if (sample) for (const v of SAMPLE) this.vars.set(v.name, v.value);
  }

  list(): EnvironmentVariable[] {
    return [...this.vars.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => ({ name, value }));
  }

  /** All or nothing: the whole batch is checked on a copy first. */
  update(changes: EnvironmentVariableChange[]) {
    const next = new Map(this.vars);
    for (const c of changes) {
      if (c.value === null) {
        next.delete(c.name);
        continue;
      }
      const problem = nameProblem(c.name) ?? valueProblem(c.value);
      if (problem) throw new DataSourceError("invalid_request", `${c.name || "(no name)"}: ${problem}`);
      next.set(c.name, c.value);
    }
    const problem = setProblem([...next].map(([name, value]) => ({ name, value })));
    if (problem) throw new DataSourceError("invalid_request", problem);
    this.vars = next;
  }
}
