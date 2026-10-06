// A pending schema's validation, persisted as Convex's (STUDY-127): `_schema_validations` holds one attempt per
// (schema, table) the walk checks, `{schemaId, tableName, state}` with `state` pending, valid or failed;
// `_schema_validation_progress` its counters, `{validationId, numDocsValidated, totalDocs}`, kept apart so a
// progress flush never conflicts with a failure (crates/database/src/bootstrap_model/schema_validations,
// schema_validation_progress). The attempts of a schema are deleted when it becomes active, fails or is
// overwritten; at a start every attempt is deleted and the walk of a pending schema begins again.
import { SCHEMA_VALIDATION_PROGRESS_TABLE, SCHEMA_VALIDATIONS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

export type ValidationState = { state: "pending" } | { state: "valid" } | { state: "failed"; error: string };
export type SchemaValidation = { _id: string; schemaId: string; tableName: string; state: ValidationState };
export type SchemaValidationProgress = {
  _id: string;
  validationId: string;
  numDocsValidated: bigint;
  totalDocs: bigint | null;
};

const sys = <T>(db: Tx, f: () => Promise<T>) => db.asSystem(f);

async function attemptsOf(db: Tx, schemaId: string, tableName?: string): Promise<SchemaValidation[]> {
  return (await sys(db, () =>
    db
      .query(SCHEMA_VALIDATIONS_TABLE)
      .withIndex("by_schema_id_and_table_name", (q) =>
        tableName === undefined ? q.eq("schemaId", schemaId) : q.eq("schemaId", schemaId).eq("tableName", tableName),
      )
      .collect(),
  )) as unknown as SchemaValidation[];
}

/** An attempt's counters (every attempt has one), or null once it is gone. */
export async function progressOf(db: Tx, validationId: string): Promise<SchemaValidationProgress | null> {
  return (await sys(db, () =>
    db
      .query(SCHEMA_VALIDATION_PROGRESS_TABLE)
      .withIndex("by_validation_id", (q) => q.eq("validationId", validationId))
      .unique(),
  )) as unknown as SchemaValidationProgress | null;
}

async function deleteAttempt(db: Tx, id: string) {
  const progress = await progressOf(db, id);
  if (progress) await sys(db, () => db.delete(SCHEMA_VALIDATION_PROGRESS_TABLE, progress._id));
  await sys(db, () => db.delete(SCHEMA_VALIDATIONS_TABLE, id));
}

/**
 * Convex's `start_table_validation`: a fresh `pending` attempt for one table of `schemaId` with zero progress,
 * replacing an earlier attempt for it (its new id fences a walk still holding the old one).
 */
export async function startTableValidation(
  db: Tx,
  schemaId: string,
  tableName: string,
  totalDocs: number | null,
): Promise<string> {
  for (const old of await attemptsOf(db, schemaId, tableName)) await deleteAttempt(db, old._id);
  const id = await sys(db, () =>
    db.insert(SCHEMA_VALIDATIONS_TABLE, { schemaId, tableName, state: { state: "pending" } }),
  );
  await sys(db, () =>
    db.insert(SCHEMA_VALIDATION_PROGRESS_TABLE, {
      validationId: id,
      numDocsValidated: 0n,
      totalDocs: totalDocs === null ? null : BigInt(totalDocs),
    }),
  );
  return id;
}

/** The attempt, while it is still `pending`: a walk's updates apply to nothing else (Convex's `update_attempt`). */
async function pendingAttempt(db: Tx, id: string): Promise<SchemaValidation | null> {
  const row = (await sys(db, () => db.get(SCHEMA_VALIDATIONS_TABLE, id))) as unknown as SchemaValidation | null;
  return row?.state.state === "pending" ? row : null;
}

/**
 * Convex's `RecordProgress`: `count` more documents checked; `totalDocs` is kept from the start unless it was
 * unknown then. False when the attempt is gone or no longer pending (the walk was canceled).
 */
export async function recordValidationProgress(
  db: Tx,
  id: string,
  count: number,
  totalDocs: number | null,
): Promise<boolean> {
  if (!(await pendingAttempt(db, id))) return false;
  const progress = await progressOf(db, id);
  if (!progress) throw new Error("Validation attempt is missing its progress");
  await sys(db, () =>
    db.patch(SCHEMA_VALIDATION_PROGRESS_TABLE, progress._id, {
      numDocsValidated: progress.numDocsValidated + BigInt(count),
      totalDocs: progress.totalDocs ?? (totalDocs === null ? null : BigInt(totalDocs)),
    }),
  );
  return true;
}

/** Convex's `MarkValid`, once the table's walk is done. False when the attempt was canceled. */
export async function markValidationValid(db: Tx, id: string): Promise<boolean> {
  if (!(await pendingAttempt(db, id))) return false;
  await sys(db, () => db.patch(SCHEMA_VALIDATIONS_TABLE, id, { state: { state: "valid" } }));
  return true;
}

/** Convex's `delete_validations_for_schema`: when the schema becomes active, fails or is overwritten. */
export async function deleteValidationsForSchema(db: Tx, schemaId: string): Promise<void> {
  for (const a of await attemptsOf(db, schemaId)) await deleteAttempt(db, a._id);
}

/**
 * At a start (Convex's `reset_for_compatibility`): every attempt is deleted; the walk of a pending schema
 * starts over with new ones. (bunvex has no staged validators whose attempts would restart.)
 */
export async function resetSchemaValidations(db: Tx): Promise<void> {
  for (const a of (await sys(db, () => db.query(SCHEMA_VALIDATIONS_TABLE).collect())) as unknown as SchemaValidation[])
    await sys(db, () => db.delete(SCHEMA_VALIDATIONS_TABLE, a._id));
  for (const p of (await sys(db, () =>
    db.query(SCHEMA_VALIDATION_PROGRESS_TABLE).collect(),
  )) as unknown as SchemaValidationProgress[])
    await sys(db, () => db.delete(SCHEMA_VALIDATION_PROGRESS_TABLE, p._id));
}

/**
 * The dashboard's `getSchemas:schemaValidationProgress`, as Convex's: the pending schema's attempts summed —
 * documents checked, and the total when every attempt knows it (0 reads as unknown) — or null when no schema
 * is pending or it has no attempt.
 */
export async function schemaValidationProgress(
  db: Tx,
  pendingSchemaId: string | null,
): Promise<{ numDocsValidated: number; totalDocs: number | null } | null> {
  if (pendingSchemaId === null) return null;
  const attempts = await attemptsOf(db, pendingSchemaId);
  if (attempts.length === 0) return null;
  let done = 0;
  let total = 0;
  let known = true;
  for (const a of attempts) {
    const p = await progressOf(db, a._id);
    done += Number(p?.numDocsValidated ?? 0n);
    if (p?.totalDocs === null || p?.totalDocs === undefined) known = false;
    else total += Number(p.totalDocs);
  }
  return { numDocsValidated: done, totalDocs: known ? total || null : null };
}

/** Convex's flush interval: every 5 % of the table or 500 documents, whichever is fewer (at least 1). */
export const progressThreshold = (totalDocs: number | null) =>
  totalDocs === null ? 500 : Math.max(1, Math.min(500, Math.ceil(totalDocs * 0.05)));
