// A schema's validations, persisted as Convex's (STUDY-127, STUDY-106 §7.1): `_schema_validations` holds one row per
// (schema, table), `{schemaId, tableName, validatorHash?, state}` with `state` pending, valid or failed;
// `_schema_validation_progress` its counters, `{validationId, numDocsValidated, totalDocs}`, kept apart so a
// progress flush never conflicts with a failure (crates/database/src/bootstrap_model/schema_validations,
// schema_validation_progress). Two kinds share the table, told apart by `validatorHash`: the enforced walk's (no
// hash), made while the schema is pending and deleted when it becomes active; and a staged validator's (the
// validator's hash), made when the schema is pushed and kept while it is in progress or active; a write its staged
// validator refuses fails it in the write's own transaction. Every row of a schema goes when it fails or is
// overwritten; a start keeps them all (900fe2c: a `valid` staged row stays true, every write being checked).
import { createHash } from "node:crypto";
import { SCHEMA_VALIDATION_PROGRESS_TABLE, SCHEMA_VALIDATIONS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";
import { isSubset } from "./validator-subset.ts";

export type ValidationState = { state: "pending" } | { state: "valid" } | { state: "failed"; error: string };
export type SchemaValidation = {
  _id: string;
  schemaId: string;
  tableName: string;
  validatorHash?: string;
  state: ValidationState;
};

/** A table's staged validator: its JSON as the schema stores it (`stagedDocumentType`) and that text's hash. */
export type StagedValidator = { json: { type: string; [k: string]: unknown }; hash: string };

/**
 * Convex's `DocumentSchema::content_hash`: the lowercase hex sha256 of the validator's canonical JSON, the text
 * the schema stores for it (object fields by name; a union's members in their order).
 */
export const validatorHash = (canonicalText: string) => createHash("sha256").update(canonicalText).digest("hex");
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
  hash?: string,
): Promise<string> {
  for (const old of await attemptsOf(db, schemaId, tableName)) await deleteAttempt(db, old._id);
  return insertValidation(db, schemaId, tableName, hash, { state: "pending" }, 0n, totalDocs);
}

/**
 * Convex's `insert_validation`, every insert's way in: a schema has at most one row per table (readers look the
 * pair up as unique).
 */
async function insertValidation(
  db: Tx,
  schemaId: string,
  tableName: string,
  hash: string | undefined,
  state: ValidationState,
  numDocsValidated: bigint,
  totalDocs: number | bigint | null,
): Promise<string> {
  if ((await attemptsOf(db, schemaId, tableName)).length)
    throw new Error(`Schema ${schemaId} already has a validation for table ${tableName}`);
  const id = await sys(db, () =>
    db.insert(SCHEMA_VALIDATIONS_TABLE, {
      schemaId,
      tableName,
      ...(hash === undefined ? {} : { validatorHash: hash }),
      state,
    }),
  );
  await sys(db, () =>
    db.insert(SCHEMA_VALIDATION_PROGRESS_TABLE, {
      validationId: id,
      numDocsValidated,
      totalDocs: totalDocs === null ? null : BigInt(totalDocs),
    }),
  );
  return id;
}

/** A schema's staged row with its counters and the validator it proves (Convex's `StagedValidationWithProgress`). */
export type StagedCarryOver = {
  tableName: string;
  validator: StagedValidator["json"];
  hash: string;
  state: ValidationState;
  numDocsValidated: bigint;
  totalDocs: bigint | null;
};

/**
 * Convex's `staged_validations_with_progress`: the staged rows of `schemaId` whose hash is still its staged
 * validator's for the table, with their counters, to be carried into the next schema.
 */
export async function stagedValidationsWithProgress(
  db: Tx,
  schemaId: string,
  staged: Map<string, StagedValidator>,
): Promise<StagedCarryOver[]> {
  if (staged.size === 0) return [];
  const out: StagedCarryOver[] = [];
  for (const a of await attemptsOf(db, schemaId)) {
    const v = staged.get(a.tableName);
    if (!v || a.validatorHash !== v.hash) continue;
    const p = await progressOf(db, a._id);
    out.push({
      tableName: a.tableName,
      validator: v.json,
      hash: v.hash,
      state: a.state,
      numDocsValidated: p?.numDocsValidated ?? 0n,
      totalDocs: p?.totalDocs ?? null,
    });
  }
  return out;
}

/**
 * Convex's `can_reuse_for`: a pending row only for the same validator; a valid one when the new validator accepts
 * everything the old one did (`is_subset`); never a failed one.
 */
function canReuseFor(c: StagedCarryOver, next: StagedValidator) {
  if (c.state.state === "pending") return c.hash === next.hash;
  if (c.state.state === "valid") return isSubset(c.validator, next.json);
  return false;
}

/**
 * Convex's `initialize_staged_validators`, for a schema just pushed: one row per table with a staged validator, its
 * state and counters taken from a reusable outgoing row (a valid one first, then the most progress), else `pending`
 * with nothing checked.
 */
export async function initializeStagedValidators(
  db: Tx,
  schemaId: string,
  staged: Map<string, StagedValidator>,
  carryOver: StagedCarryOver[],
): Promise<void> {
  for (const [tableName, v] of [...staged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let best: StagedCarryOver | undefined;
    for (const c of carryOver) {
      if (c.tableName !== tableName || !canReuseFor(c, v)) continue;
      const rank = (x: StagedCarryOver) => [x.state.state === "valid" ? 1 : 0, x.numDocsValidated] as const;
      const [bv, bn] = best ? rank(best) : [-1, -1n];
      const [cv, cn] = rank(c);
      if (cv > bv || (cv === bv && cn > bn)) best = c;
    }
    await insertValidation(
      db,
      schemaId,
      tableName,
      v.hash,
      best ? best.state : { state: "pending" },
      best ? best.numDocsValidated : 0n,
      best ? best.totalDocs : null,
    );
  }
}

/**
 * Convex's `retry_failed_staged_validators`, for a push of an unchanged schema: its failed staged rows whose hash is
 * still current start over as `pending`.
 */
export async function retryFailedStagedValidators(
  db: Tx,
  schemaId: string,
  staged: Map<string, StagedValidator>,
): Promise<void> {
  if (staged.size === 0) return;
  for (const a of await attemptsOf(db, schemaId)) {
    if (a.state.state !== "failed") continue;
    const v = staged.get(a.tableName);
    if (!v || a.validatorHash !== v.hash) continue;
    await startTableValidation(db, schemaId, a.tableName, null, a.validatorHash);
  }
}

/**
 * Convex's `SchemaValidationModel::mark_failed`, for a write a staged validator refuses (900fe2c): the table's row
 * of `schemaId` becomes failed with `error`, a pending or a valid one alike; a failed one keeps its first error; a
 * missing one (the schema failed, or the validation was replaced) is left alone.
 */
export async function markStagedValidationFailed(db: Tx, schemaId: string, tableName: string, error: string) {
  const [row] = await attemptsOf(db, schemaId, tableName);
  if (!row || row.state.state === "failed") return;
  await sys(db, () => db.patch(SCHEMA_VALIDATIONS_TABLE, row._id, { state: { state: "failed", error } }));
}

/**
 * The staged rows of `schemaId` still to walk (Convex's `staged_schema_validations`): pending, with the current hash
 * of the table's staged validator, in table-name order.
 */
export async function pendingStagedValidations(
  db: Tx,
  schemaId: string,
  staged: Map<string, StagedValidator>,
): Promise<{ id: string; tableName: string }[]> {
  if (staged.size === 0) return [];
  return (await attemptsOf(db, schemaId))
    .filter((a) => a.state.state === "pending" && a.validatorHash === staged.get(a.tableName)?.hash)
    .map((a) => ({ id: a._id, tableName: a.tableName }))
    .sort((a, b) => (a.tableName < b.tableName ? -1 : a.tableName > b.tableName ? 1 : 0));
}

/** Convex's `StartWalk`: a pending row's counters start over at 0 of `totalDocs`. False when it is not pending. */
export async function startStagedWalk(db: Tx, id: string, totalDocs: number | null): Promise<boolean> {
  if (!(await pendingAttempt(db, id))) return false;
  const progress = await progressOf(db, id);
  if (!progress) throw new Error("Validation attempt is missing its progress");
  await sys(db, () =>
    db.patch(SCHEMA_VALIDATION_PROGRESS_TABLE, progress._id, {
      numDocsValidated: 0n,
      totalDocs: totalDocs === null ? null : BigInt(totalDocs),
    }),
  );
  return true;
}

/** Convex's `MarkFailed` from a walk: a pending row fails with `error`. False when it is not pending any more. */
export async function markWalkFailed(db: Tx, id: string, error: string): Promise<boolean> {
  if (!(await pendingAttempt(db, id))) return false;
  await sys(db, () => db.patch(SCHEMA_VALIDATIONS_TABLE, id, { state: { state: "failed", error } }));
  return true;
}

/** Convex's `delete_enforced_validations_for_schema`, at activation: the enforced walk's rows go, staged ones stay. */
export async function deleteEnforcedValidationsForSchema(db: Tx, schemaId: string): Promise<void> {
  for (const a of await attemptsOf(db, schemaId)) if (a.validatorHash === undefined) await deleteAttempt(db, a._id);
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
