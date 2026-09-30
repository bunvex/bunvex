// Mutations and actions in flight, as Convex's `sync/request_manager.ts`. A successful mutation's promise
// resolves only once a transition at or past its commit ts arrives, so the caller already sees its write in
// every subscription (read-your-writes). A failed mutation, and any action, resolves at once. On a new socket,
// mutations are re-sent (the server runs each at most once, `_session_requests`), and actions fail.
import type { v1 } from "@bunvex/protocol";
import { fromJsonValue, type JSONValue, type Value } from "@bunvex/values";
import type { FunctionResult } from "./function-result.ts";
import { type Logger, logForFunction } from "./logging.ts";

type RequestStatus =
  | { status: "Requested" | "NotSent"; onResult: (result: FunctionResult) => void; requestedAt: Date }
  | { status: "Completed"; result: FunctionResult; onResolve: () => void; ts: bigint };

type Request = v1.MutationRequest | v1.ActionRequest;

export class RequestManager {
  private inflightRequests = new Map<v1.RequestId, { message: Request; status: RequestStatus }>();
  private requestsOlderThanRestart = new Set<v1.RequestId>();
  private inflightMutationsCount = 0;
  private inflightActionsCount = 0;

  constructor(
    private readonly logger: Logger,
    private readonly markConnectionStateDirty: () => void,
  ) {}

  request(message: Request, sent: boolean): Promise<FunctionResult> {
    const result = new Promise<FunctionResult>((resolve) => {
      this.inflightRequests.set(message.requestId, {
        message,
        status: { status: sent ? "Requested" : "NotSent", requestedAt: new Date(), onResult: resolve },
      });
      if (message.type === "Mutation") this.inflightMutationsCount++;
      else this.inflightActionsCount++;
    });
    this.markConnectionStateDirty();
    return result;
  }

  /**
   * A response arrived. Returns the request when it is complete now (a failure, or an action), so its
   * optimistic update can be dropped; a successful mutation completes later, in `removeCompleted`.
   */
  onResponse(
    response: v1.MutationResponse | v1.ActionResponse,
  ): { requestId: v1.RequestId; result: FunctionResult } | null {
    const info = this.inflightRequests.get(response.requestId);
    // A response to a request no longer tracked (answered twice across a reconnect), or already completed
    // (restart re-sends completed mutations): nothing left to do.
    if (info === undefined || info.status.status === "Completed") return null;
    const udfType = info.message.type === "Mutation" ? "mutation" : "action";
    const udfPath = info.message.udfPath;
    for (const line of response.logLines) logForFunction(this.logger, "info", udfType, udfPath, line);

    const status = info.status;
    let result: FunctionResult;
    if (response.success) {
      result = {
        success: true,
        logLines: response.logLines,
        value: fromJsonValue(response.result as JSONValue) as Value,
      };
    } else {
      logForFunction(this.logger, "error", udfType, udfPath, response.result);
      result = {
        success: false,
        errorMessage: response.result,
        ...(response.errorData === undefined
          ? {}
          : { errorData: fromJsonValue(response.errorData as JSONValue) as Value }),
        logLines: response.logLines,
      };
    }
    const onResolve = () => status.onResult(result);

    // Failures have no side effects to wait for; actions are not ordered with queries and mutations.
    if (response.type === "ActionResponse" || !response.success) {
      onResolve();
      this.forget(response.requestId, info.message.type);
      return { requestId: response.requestId, result };
    }
    // Read-your-writes: resolve once a transition passes this commit ts.
    info.status = { status: "Completed", result, ts: response.ts, onResolve };
    return null;
  }

  /** Resolve the mutations whose commit ts the client's queries have now reached, and return them. */
  removeCompleted(ts: bigint): Map<v1.RequestId, FunctionResult> {
    const completed = new Map<v1.RequestId, FunctionResult>();
    for (const [requestId, info] of this.inflightRequests) {
      const s = info.status;
      if (s.status === "Completed" && s.ts <= ts) {
        s.onResolve();
        completed.set(requestId, s.result);
        this.forget(requestId, info.message.type, false);
      }
    }
    if (completed.size > 0) this.markConnectionStateDirty();
    return completed;
  }

  private forget(requestId: v1.RequestId, type: Request["type"], markDirty = true) {
    this.inflightRequests.delete(requestId);
    this.requestsOlderThanRestart.delete(requestId);
    if (type === "Mutation") this.inflightMutationsCount--;
    else this.inflightActionsCount--;
    if (markDirty) this.markConnectionStateDirty();
  }

  /**
   * A new socket: the messages to send again. Every mutation not yet reflected, completed ones included (the
   * server must still move this client past their ts; they run once). Actions are not idempotent: they fail.
   */
  restart(): v1.ClientMessage[] {
    this.requestsOlderThanRestart = new Set(this.inflightRequests.keys());
    const messages: v1.ClientMessage[] = [];
    for (const [requestId, value] of this.inflightRequests) {
      if (value.status.status === "NotSent") {
        value.status.status = "Requested";
        messages.push(value.message);
        continue;
      }
      if (value.message.type === "Mutation") {
        messages.push(value.message);
      } else {
        if (value.status.status === "Completed") throw new Error("Action should never be in 'Completed' state");
        this.inflightRequests.delete(requestId);
        this.requestsOlderThanRestart.delete(requestId);
        this.inflightActionsCount--;
        value.status.onResult({
          success: false,
          errorMessage: "Connection lost while action was in flight",
          logLines: [],
        });
      }
    }
    this.markConnectionStateDirty();
    return messages;
  }

  /** After a pause (auth): the requests that were not sent yet. */
  resume(): v1.ClientMessage[] {
    const messages: v1.ClientMessage[] = [];
    for (const value of this.inflightRequests.values())
      if (value.status.status === "NotSent") {
        value.status.status = "Requested";
        messages.push(value.message);
      }
    return messages;
  }

  /** Requests sent and not answered yet (what the unsaved-changes warning waits for). */
  hasIncompleteRequests(): boolean {
    for (const r of this.inflightRequests.values()) if (r.status.status === "Requested") return true;
    return false;
  }

  /** Requests in flight, including answered mutations not reflected yet. */
  hasInflightRequests(): boolean {
    return this.inflightRequests.size > 0;
  }

  hasSyncedPastLastReconnect(): boolean {
    return this.requestsOlderThanRestart.size === 0;
  }

  timeOfOldestInflightRequest(): Date | null {
    if (this.inflightRequests.size === 0) return null;
    let oldest = Date.now();
    for (const r of this.inflightRequests.values())
      if (r.status.status !== "Completed" && r.status.requestedAt.getTime() < oldest)
        oldest = r.status.requestedAt.getTime();
    return new Date(oldest);
  }

  inflightMutations(): number {
    return this.inflightMutationsCount;
  }

  inflightActions(): number {
    return this.inflightActionsCount;
  }
}
