// What the server SENT on the current socket, as Convex's `sync/remote_query_set.ts`: the results by query
// id and the state version they are at. Transitions must chain: one whose start is not the current version
// is a protocol violation.
import type { v1 } from "@bunvex/protocol";
import { fromJsonValue, type JSONValue, type Value } from "@bunvex/values";
import type { FunctionResult } from "./function-result.ts";
import { type Logger, logForFunction } from "./logging.ts";

export class RemoteQuerySet {
  private version: v1.StateVersion = { querySet: 0, ts: 0n, identity: 0 };
  private readonly results = new Map<v1.QueryId, FunctionResult>();

  constructor(
    private readonly queryPath: (queryId: v1.QueryId) => string | null,
    private readonly logger: Logger,
  ) {}

  transition(transition: v1.Transition): void {
    const start = transition.startVersion;
    const v = this.version;
    if (v.querySet !== start.querySet || v.ts !== start.ts || v.identity !== start.identity)
      throw new Error(
        `Invalid start version: ${start.ts}:${start.querySet}:${start.identity}, transitioning from ${v.ts}:${v.querySet}:${v.identity}`,
      );
    for (const m of transition.modifications) {
      if (m.type === "QueryRemoved") {
        this.results.delete(m.queryId);
        continue;
      }
      const path = this.queryPath(m.queryId);
      if (path) for (const line of m.logLines) logForFunction(this.logger, "info", "query", path, line);
      if (m.type === "QueryUpdated") {
        this.results.set(m.queryId, {
          success: true,
          value: fromJsonValue((m.value ?? null) as JSONValue) as Value,
          logLines: m.logLines,
        });
      } else {
        this.results.set(m.queryId, {
          success: false,
          errorMessage: m.errorMessage,
          ...(m.errorData === undefined ? {} : { errorData: fromJsonValue(m.errorData as JSONValue) as Value }),
          logLines: m.logLines,
        });
      }
    }
    this.version = transition.endVersion;
  }

  remoteQueryResults(): Map<v1.QueryId, FunctionResult> {
    return this.results;
  }

  timestamp(): bigint {
    return this.version.ts;
  }
}
