// The deployment's run state (STUDY-63), as Convex's `_backend_state` (crates/model/src/backend_state):
// one document `{system, usage_limit, user}`, each "none" when running. An operator pauses a deployment
// (`user: "paused"`); the other two are set by Convex's cloud (suspension, usage limits). While any is not
// "none" the backend is stopped: scheduled functions and crons wait, and file storage refuses.
import { BACKEND_STATE_TABLE } from "./catalog.ts";
import type { LogEntry } from "./committer.ts";
import type { IndexId } from "./persistence/index.ts";
import type { Tx } from "./tx.ts";

export type BackendState = { system: string; usage_limit: string; user: string };

const RUNNING: BackendState = { system: "none", usage_limit: "none", user: "none" };

/**
 * The state's document as Convex's `BackendStateModel::initialize` writes it when `initialize_application_system_tables`
 * creates the table (crates/model/src/backend_state/mod.rs): running, `{system, usage_limit, user}` all "none".
 * bunvex writes it in the commit after the one that created the table (a transaction cannot write a table its own
 * catalog commit creates), at the first start, before anything else can run; a store that has it keeps it.
 */
export async function initializeBackendState(db: Tx): Promise<void> {
  if (!(await db.asSystem(() => db.query(BACKEND_STATE_TABLE).first())))
    await db.asSystem(() => db.insert(BACKEND_STATE_TABLE, { ...RUNNING }));
}

/** The state, read in `db` (running when there is no document, as in a store whose table was emptied). */
export async function readBackendState(db: Tx): Promise<BackendState> {
  const row = (await db.asSystem(() => db.query(BACKEND_STATE_TABLE).first())) as BackendState | null;
  return row ? { system: row.system, usage_limit: row.usage_limit, user: row.user } : { ...RUNNING };
}

/**
 * The state as every user function reads it (`failWhileNotRunning`), without a scan each time: the state
 * as of the last commit that wrote `_backend_state`, served to transactions whose snapshot is at or after
 * that commit (a scan at such a snapshot would read the same). Others scan. Either way the transaction
 * records the same read (the whole table), so a subscribed query reruns and a mutation conflicts when a
 * pause commits.
 */
export class BackendStateCache {
  private writtenTs = 0n;
  private cached: { from: bigint; state: BackendState; exists: boolean } | null = null;

  constructor(private readonly byIdIndex: () => IndexId | undefined) {}

  /** Commits, as they become visible (before any transaction can begin at their ts). */
  observe(entries: LogEntry[]) {
    const index = this.byIdIndex();
    for (const e of entries) if (e.writes.some((w) => w.index === index)) this.writtenTs = e.ts;
  }

  /** The state at `db`'s snapshot; a system read, out of the function's limits as in Convex. */
  async read(db: Tx): Promise<BackendState> {
    const c = this.cached;
    const from = this.writtenTs;
    if (c !== null && c.from === from && db.snapshot >= from) {
      db.recordUncounted(this.byIdIndex());
      // The row a scan would have read, as Convex's `TableStats` counts system reads too.
      if (c.exists) db.countRowsReadOf(BACKEND_STATE_TABLE, 1);
      return { ...c.state };
    }
    const row = await db.uncountedRead(this.byIdIndex(), () =>
      db.asSystem(() => db.query(BACKEND_STATE_TABLE).first()),
    );
    const state = row
      ? { system: row.system as string, usage_limit: row.usage_limit as string, user: row.user as string }
      : { ...RUNNING };
    if (db.snapshot >= from && this.writtenTs === from)
      this.cached = { from, state: { ...state }, exists: row !== null };
    return state;
  }
}

/** Convex's `BackendState::is_stopped`. */
export const isStopped = (s: BackendState) => s.system !== "none" || s.usage_limit !== "none" || s.user !== "none";

/** Convex's `set_usage_limit_stop_state` (STUDY-61): the previous state, or null when unchanged. */
export async function setUsageLimitStopState(db: Tx, usageLimit: "none" | "disabled"): Promise<BackendState | null> {
  const row = (await db.asSystem(() => db.query(BACKEND_STATE_TABLE).first())) as
    | (BackendState & { _id: string })
    | null;
  const current = row ? { system: row.system, usage_limit: row.usage_limit, user: row.user } : { ...RUNNING };
  if (current.usage_limit === usageLimit) return null;
  if (row) await db.asSystem(() => db.patch(BACKEND_STATE_TABLE, row._id, { usage_limit: usageLimit }));
  else await db.asSystem(() => db.insert(BACKEND_STATE_TABLE, { ...RUNNING, usage_limit: usageLimit }));
  return current;
}

/** Convex's `set_user_stop_state`: the previous state, or null when it was already `user`. */
export async function setUserStopState(db: Tx, user: "none" | "paused"): Promise<BackendState | null> {
  const row = (await db.asSystem(() => db.query(BACKEND_STATE_TABLE).first())) as
    | (BackendState & { _id: string })
    | null;
  const current = row ? { system: row.system, usage_limit: row.usage_limit, user: row.user } : { ...RUNNING };
  if (current.user === user) return null;
  if (row) await db.asSystem(() => db.patch(BACKEND_STATE_TABLE, row._id, { user }));
  else await db.asSystem(() => db.insert(BACKEND_STATE_TABLE, { ...RUNNING, user }));
  return current;
}

/**
 * Why user functions cannot run, or null when they can: Convex's `fail_while_not_running`
 * (crates/udf/src/validation.rs) and its messages, in its order. bunvex only ever sets `user`; the other
 * states come from a copied `_backend_state` (an import), so they are covered as well.
 */
export function notRunningMessage(s: BackendState): string | null {
  if (s.system === "disabled") return "This deployment has been disabled. Functions cannot run until it is enabled.";
  if (s.system === "none" && s.usage_limit === "disabled")
    return "This deployment has been disabled because it exceeded a configured usage limit. Update or disable the usage limit in the deployment settings to resume function execution.";
  if (s.system === "suspended") return "Cannot run functions while this deployment is suspended.";
  if (s.user === "paused")
    return "Cannot run functions while this deployment is paused. Resume the deployment in the dashboard settings to allow functions to run.";
  return null;
}

/** Convex's `BackendIsNotRunning`: file storage while the deployment is stopped. */
export class BackendIsNotRunningError extends Error {
  readonly code = "BackendIsNotRunning";
  constructor() {
    super("Cannot perform this operation when the backend is not running");
    this.name = "BackendIsNotRunningError";
  }
}
