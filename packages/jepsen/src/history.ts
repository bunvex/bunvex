// A history (STUDY-57 §3.3): every operation a client invoked, with the real-time window it ran in, as Jepsen
// records it. `start` is taken just before the call and `end` just after its answer (performance.now(), one
// clock for every client: they share this process). An operation whose answer never came — the connection
// died, the run ended — is "info": it may or may not have taken effect, and the checkers treat it so.

export type Status = "ok" | "fail" | "info";

export type Op = {
  /** Which client (process, in Jepsen's terms) invoked it. */
  client: number;
  /** The function and its arguments, as called. */
  f: string;
  args: Record<string, unknown>;
  start: number;
  /** Infinity for an "info" operation. */
  end: number;
  status: Status;
  /** The answer, for "ok"; the error message, for "fail". */
  result?: unknown;
  error?: string;
};

export class History {
  readonly ops: Op[] = [];
  private readonly t0 = performance.now();

  now() {
    return performance.now() - this.t0;
  }

  /** Run `call` as client `client`'s operation `f`, recording its window and outcome. */
  async invoke<T>(client: number, f: string, args: Record<string, unknown>, call: () => Promise<T>): Promise<Op> {
    const op: Op = { client, f, args, start: this.now(), end: Infinity, status: "info" };
    this.ops.push(op);
    try {
      op.result = await call();
      op.status = "ok";
    } catch (e) {
      op.error = e instanceof Error ? e.message : String(e);
      // A mutation that failed with an error from the function or the server did not take effect; one lost to
      // the connection or the run's end might have: the caller marks those "info" with `indeterminate`.
      op.status = indeterminate(op.error) ? "info" : "fail";
    } finally {
      if (op.status !== "info") op.end = this.now();
    }
    return op;
  }
}

/** Errors after which an operation may or may not have taken effect. */
export function indeterminate(message: string): boolean {
  return /closed|connection|socket|timed out|aborted|stopped|shut ?down/i.test(message);
}

/** A failure the workload expects: a mutation that lost its OCC race on every retry (Convex's user OCC error). */
export function expectedFailure(message: string): boolean {
  return /changed while this mutation was being run/.test(message);
}
