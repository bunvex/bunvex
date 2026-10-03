// The deployment audit log (STUDY-48), as Convex's `_deployment_audit_log`
// (crates/model/src/deployment_audit_log): one document per event, written in the transaction that makes
// the change. A document is `{action, metadata, member_id, token_id, app_client_id, client_ip,
// client_user_agent}` (snake_case, absent values null); its time is its `_creationTime`.
import type { Value } from "@bunvex/values";
import { DEPLOYMENT_AUDIT_LOG_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

/** One event: Convex's `DeploymentAuditLogEvent` as its `action` and `metadata`. */
export type AuditLogEvent = { action: string; metadata: Record<string, Value> };

/** Who made the change: an admin key's member (null for the system), and the request it came in. */
export type AuditLogActor = { memberId: bigint | null; ip: string | null; userAgent: string | null };

export const SYSTEM_ACTOR: AuditLogActor = { memberId: null, ip: null, userAgent: null };

/** Record `events` in `db`'s transaction (Convex's `DeploymentAuditLogModel::insert`). */
export async function insertAuditLogEvents(db: Tx, events: AuditLogEvent[], actor: AuditLogActor) {
  for (const e of events)
    await db.asSystem(() =>
      db.insert(DEPLOYMENT_AUDIT_LOG_TABLE, {
        action: e.action,
        app_client_id: null,
        client_ip: actor.ip,
        client_user_agent: actor.userAgent,
        member_id: actor.memberId,
        metadata: e.metadata,
        token_id: null,
      }),
    );
}
