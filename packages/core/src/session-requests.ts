// Mutation idempotency for the sync protocol (STUDY-23 §4.3, P5/P6), after Convex's `_session_requests`
// (crates/model/src/session_requests, crates/application/src/application_function_runner/mod.rs
// `check_mutation_status` / `write_mutation_status`, crates/application/src/system_table_cleanup):
//
// - A client resends the mutations it got no answer for when it reconnects. Each one is identified by the
//   client's session id and its request id.
// - Each attempt of a session mutation first looks up its (sessionId, requestId) record. The lookup is in
//   the read-set, so a concurrent commit of the same request conflicts. When a record exists, the mutation
//   does not run again: the caller gets the recorded result and log lines back.
// - A successful run records its outcome in the SAME transaction as its writes, so the record exists
//   exactly when the mutation committed. A failed run records nothing: it wrote nothing, and a resend
//   simply runs it again.
// - Records older than the retention window (two weeks by default) are deleted in the background.

import { type CommitTsPlaceholder, commitTsPlaceholder, resolveCommitTsJson } from "@bunvex/values";
import { SESSION_REQUESTS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

export const SESSION_REQUESTS_INDEX = "by_session_id_and_request_id";
/** Convex's MAX_SESSION_CLEANUP_DURATION default: records live two weeks. */
export const SESSION_REQUEST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Rows deleted per transaction, and per second (Convex's SYSTEM_TABLE_CLEANUP_CHUNK_SIZE / _ROWS_PER_SECOND). */
export const SESSION_CLEANUP_CHUNK = 64;
export const SESSION_CLEANUP_ROWS_PER_SECOND = 256;

/** One mutation of a sync session. */
export type SessionRequestId = { sessionId: string; requestId: number };
/** What a committed session mutation answered: its result as JSON text and its log lines. */
export type SessionRequestOutcome = { result: string; logLines: string[] };

type SessionRequestDoc = {
  sessionId: string;
  requestId: bigint;
  outcome: { type: "mutation"; result: string; logLines: string[] };
  identity: string;
  /** Set when the result holds a commit timestamp: resolved, with it, at the commit. */
  commitTs?: bigint | CommitTsPlaceholder;
};

/** The recorded outcome of `id`, if that request already committed. */
export async function findSessionRequest(db: Tx, id: SessionRequestId): Promise<SessionRequestOutcome | null> {
  const docs = (await db.asSystem(() =>
    db
      .query(SESSION_REQUESTS_TABLE)
      .withIndex(SESSION_REQUESTS_INDEX, (q) => q.eq("sessionId", id.sessionId).eq("requestId", BigInt(id.requestId)))
      .take(2),
  )) as unknown as SessionRequestDoc[];
  if (docs.length > 1) throw new Error("Expected at most one session request record.");
  const d = docs[0];
  if (!d) return null;
  // A result holding `db.vars.commitTs` was recorded with Convex's token; the record's own `commitTs`
  // resolved to the commit's timestamp (STUDY-53).
  const result = typeof d.commitTs === "bigint" ? resolveCommitTsJson(d.outcome.result, d.commitTs) : d.outcome.result;
  return { result, logLines: d.outcome.logLines };
}

/** Record `id`'s outcome, in the transaction that commits the mutation's writes. */
export async function recordSessionRequest(db: Tx, id: SessionRequestId, outcome: SessionRequestOutcome) {
  // Convex stores the caller's identity inertly; until auth lands every caller is "unknown".
  const doc: SessionRequestDoc = {
    sessionId: id.sessionId,
    requestId: BigInt(id.requestId),
    outcome: { type: "mutation", result: outcome.result, logLines: outcome.logLines },
    identity: "unknown",
    ...(outcome.result.includes('"$commitTs"') ? { commitTs: commitTsPlaceholder } : {}),
  };
  await db.asSystem(() => db.insert(SESSION_REQUESTS_TABLE, doc));
}

/** Delete up to `limit` records created before `cutoffMs`; returns how many it deleted. */
export async function deleteSessionRequestsBefore(db: Tx, cutoffMs: number, limit: number): Promise<number> {
  return db.asSystem(async () => {
    const old = (await db
      .query(SESSION_REQUESTS_TABLE)
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoffMs))
      .take(limit)) as unknown as { _id: string }[];
    for (const d of old) await db.delete(SESSION_REQUESTS_TABLE, d._id);
    return old.length;
  });
}
