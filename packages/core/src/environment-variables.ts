// Deployment environment variables (STUDY-37), as Convex's (crates/model/src/environment_variables,
// crates/common/src/types/environment_variables.rs, application `update_environment_variables`):
//
// - the system table `_environment_variables` holds `{ name, value }`, indexed `by_name`;
// - names match `^[a-zA-Z_]+[a-zA-Z0-9_]*$` and are at most 256 bytes, values at most 8 KiB; at most 512
//   variables and 512 KiB of names and values in all; Convex's codes and messages;
// - a batch of changes is one transaction: removals first, then sets (each set replaces the document), the
//   limits checked after the changes;
// - a function reads one name at a time: the read is recorded in the read set (the `by_name` range of that
//   name), so a query that read `X` — set or not — re-runs when `X` changes, as Convex's `PreloadedEnvVars`.
//
// The variables of a snapshot come from a cache that is valid while no commit wrote the table since it was
// built; the committer tells it synchronously, before any later transaction can begin.

import type { Catalog } from "./catalog.ts";
import { ENVIRONMENT_VARIABLES_TABLE } from "./catalog.ts";
import type { Committer } from "./committer.ts";
import { compileRange, type Tx } from "./tx.ts";

export const ENV_VAR_NAME_MAX_LENGTH = 256;
export const ENV_VAR_VALUE_MAX_LENGTH = 8 * 1024;
export const ENV_VAR_LIMIT = 512;
export const ENV_VAR_TOTAL_SIZE_LIMIT = 512 * 1024;
const NAME = /^[a-zA-Z_]+[a-zA-Z0-9_]*$/;

/** A refused change, with Convex's error code. */
export class EnvironmentVariableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentVariableError";
  }
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Convex's `EnvVarName` parse: the name a function reads, or a change names. */
export function checkEnvVarName(name: string) {
  if (bytes(name) > ENV_VAR_NAME_MAX_LENGTH)
    throw new EnvironmentVariableError(
      "EnvironmentVariableNameTooLong",
      `The environment variable name ${name} is too long. Environment variable names must be less than ${ENV_VAR_NAME_MAX_LENGTH}.`,
    );
  if (!NAME.test(name))
    throw new EnvironmentVariableError(
      "EnvironmentVariableNameInvalid",
      `The environment variable name ${name} is invalid. Environment variable names must begin with a letter and may only include characters a-z, A-Z, 0-9, and underscores.`,
    );
}

export function checkEnvVarValue(value: string) {
  const n = bytes(value);
  if (n > ENV_VAR_VALUE_MAX_LENGTH)
    throw new EnvironmentVariableError(
      "EnvironmentVariableValueTooLarge",
      // Convex's message, its missing parenthesis included.
      `The environment variable value is ${n} bytes, which is too large. (max size: ${ENV_VAR_VALUE_MAX_LENGTH}`,
    );
}

export type EnvVarChange = { name: string; value: string | null };

type Row = { _id: string; name: string; value: string };

/** The variables of one deployment: the cache, the reads functions make, the batch updates. */
export class EnvironmentVariables {
  /** The ts of the last commit that wrote the table (as far as this process has seen). */
  private lastWriteTs: bigint;
  private cache: { ts: bigint; vars: Map<string, string> } | null = null;

  constructor(
    private catalog: () => Catalog,
    committer: Committer,
  ) {
    // Unknown history before now: a cache is valid only if built at or after this.
    this.lastWriteTs = committer.visibleTs;
    committer.onCommit((entries) => {
      const table = this.catalog().tables.get(ENVIRONMENT_VARIABLES_TABLE);
      if (!table) return;
      for (const e of entries)
        if (e.writes.some((w) => w.index === table.byId.id)) {
          if (e.ts > this.lastWriteTs) this.lastWriteTs = e.ts;
          this.cache = null;
        }
    }, "environment variables");
  }

  private async rows(db: Tx): Promise<Row[]> {
    return (await db.asSystem(() =>
      db.query(ENVIRONMENT_VARIABLES_TABLE).withIndex("by_name").collect(),
    )) as unknown as Row[];
  }

  /**
   * Every variable at `db`'s snapshot, without recording a read (the reads are recorded name by name,
   * through `reader`). From the cache when no write came after it was built, else from the table.
   */
  async snapshot(db: Tx): Promise<Map<string, string>> {
    const c = this.cache;
    if (c && this.lastWriteTs <= db.snapshot && this.lastWriteTs <= c.ts) return c.vars;
    const vars = new Map((await db.unrecorded(() => this.rows(db))).map((r) => [r.name, r.value]));
    if (this.lastWriteTs <= db.snapshot) this.cache = { ts: db.snapshot, vars };
    return vars;
  }

  /** Each name's read interval, built once (bounded: names come from code, but not trusted to be few). */
  private intervals = new Map<string, { index: number; lo: Uint8Array; hi: Uint8Array }>();

  /** Record that `db` read the variable `name` (set or not): a change to it invalidates the read. */
  recordRead(db: Tx, name: string) {
    let i = this.intervals.get(name);
    if (!i) {
      const ix = this.catalog().table(ENVIRONMENT_VARIABLES_TABLE).indexes.get("by_name")!;
      const r = compileRange(ix, [{ op: "eq", field: "name", value: name }]);
      i = { index: ix.id, lo: r.lo, hi: r.hi };
      if (this.intervals.size >= 4096) this.intervals.clear();
      this.intervals.set(name, i);
    }
    db.recordInterval(i);
  }

  /** A query's or mutation's reader: one name at a time, each read recorded. */
  async reader(db: Tx): Promise<(name: string) => string | undefined> {
    const vars = await this.snapshot(db);
    return (name) => {
      checkEnvVarName(name);
      this.recordRead(db, name);
      return vars.get(name);
    };
  }

  /** Every variable, by name (the CLI's `list`, the dashboard). */
  async list(db: Tx): Promise<{ name: string; value: string }[]> {
    return (await this.rows(db)).map((r) => ({ name: r.name, value: r.value }));
  }

  private checkChanges(changes: EnvVarChange[], forbidden: Iterable<string>) {
    const builtIn = new Set(forbidden);
    for (const c of changes) {
      checkEnvVarName(c.name);
      if (c.value !== null) {
        checkEnvVarValue(c.value);
        if (builtIn.has(c.name))
          throw new EnvironmentVariableError(
            "EnvVarNameForbidden",
            `Environment variable with name "${c.name}" is built-in and cannot be overridden`,
          );
      }
    }
  }

  /** Check a batch without applying it: its names, values and the limits it would leave (a dry run). */
  async check(db: Tx, changes: EnvVarChange[], forbidden: Iterable<string> = []) {
    this.checkChanges(changes, forbidden);
    this.checkLimits(applyEnvVarChanges(new Map((await this.rows(db)).map((r) => [r.name, r.value])), changes));
  }

  private checkLimits(vars: Map<string, string>) {
    if (vars.size > ENV_VAR_LIMIT)
      throw new EnvironmentVariableError(
        "EnvVarLimitMet",
        `The environment variable limit (${ENV_VAR_LIMIT}) has been met.`,
      );
    let total = 0;
    for (const [name, value] of vars) total += bytes(name) + bytes(value);
    if (total > ENV_VAR_TOTAL_SIZE_LIMIT)
      throw new EnvironmentVariableError(
        "EnvVarTotalSizeLimitMet",
        `The total size of all environment variables (${total} bytes) exceeds the limit (${ENV_VAR_TOTAL_SIZE_LIMIT} bytes).`,
      );
  }

  /**
   * Apply a batch (Convex's `update_environment_variables`), in `db`'s transaction, in Convex's order
   * (`orderEnvVarChanges`), then check the limits. `forbidden`: the built-in names, which may not be set.
   */
  async update(db: Tx, changes: EnvVarChange[], forbidden: Iterable<string> = []) {
    this.checkChanges(changes, forbidden);
    const existing = new Map((await this.rows(db)).map((r) => [r.name, r]));
    await db.asSystem(async () => {
      for (const c of orderEnvVarChanges(changes)) {
        const old = existing.get(c.name);
        if (old) {
          await db.delete(ENVIRONMENT_VARIABLES_TABLE, old._id);
          existing.delete(c.name);
        }
        if (c.value !== null)
          existing.set(c.name, {
            _id: await db.insert(ENVIRONMENT_VARIABLES_TABLE, { name: c.name, value: c.value }),
            name: c.name,
            value: c.value,
          });
      }
    });
    const vars = new Map([...existing.values()].map((r) => [r.name, r.value]));
    this.checkLimits(vars);
    return vars;
  }
}

const utf8 = new TextEncoder();
const compareBytes = (a: string, b: string) => Buffer.compare(utf8.encode(a), utf8.encode(b));

/**
 * The order a batch is applied in, as Convex's (`EnvVarChange` derives `Ord` and the route sorts the
 * batch, crates/local_backend/src/environment_variables.rs): every removal first, then the sets by name and
 * then value, compared as UTF-8 bytes. A name may appear more than once: a removal and a set of it leave the
 * set's value, two sets the greater value. Convex checks no uniqueness in this batch.
 */
export function orderEnvVarChanges(changes: readonly EnvVarChange[]): EnvVarChange[] {
  const unsets = changes.filter((c) => c.value === null);
  const sets = changes
    .filter((c) => c.value !== null)
    .sort((a, b) => compareBytes(a.name, b.name) || compareBytes(a.value!, b.value!));
  return [...unsets, ...sets];
}

/** The variables `vars` would hold after the batch (a copy). */
export function applyEnvVarChanges(vars: ReadonlyMap<string, string>, changes: readonly EnvVarChange[]) {
  const after = new Map(vars);
  for (const c of orderEnvVarChanges(changes)) {
    if (c.value === null) after.delete(c.name);
    else after.set(c.name, c.value);
  }
  return after;
}
