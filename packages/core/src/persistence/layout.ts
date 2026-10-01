// PERSIST-01 C10: the layout version a store was written with, and its read-only flag (STUDY-25 L6/L7).
//
// Convex picks its layout (V5/V6) by configuration and refuses a database of another layout (MySQL v6 will
// not initialize over a v5 or unversioned database); it evolves a layout in place with guarded, idempotent
// DDL. bunvex has one layout and no configuration for it, so every store records the version it was written
// with, and every open checks it: the same refusals, read from the store instead of from a flag.
//
// The read-only flag is Convex's `read_only` table: while it is set, a store does not open for writing
// ("data migration in progress") unless the caller allows it, as Convex's readers and migration tools do.

/** The layout every driver writes today. Bump it, with an upgrade, when a layout changes (PERSIST-01 C10). */
export const LAYOUT_VERSION = 1;

/** The store was written with a layout this bunvex cannot read, or is not a bunvex store at all. */
export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

/** The store is marked read-only (a data migration, import or export is in progress). As Convex's
 *  `ConnectError::ReadOnly`. */
export class ReadOnlyError extends Error {
  constructor(store: string) {
    super(`${store} is read-only, data migration in progress: it does not open for writing until the flag is cleared`);
    this.name = "ReadOnlyError";
  }
}

/** A driver whose store has Convex's `read_only` flag. Setting or clearing it needs no lease (as Convex's
 *  `set_read_only`): a running writer is not stopped by it; the next open is refused. */
export interface ReadOnlyFlag {
  setReadOnly(readOnly: boolean): Promise<void>;
}

/** Options every first-party driver's open takes. */
export type OpenOptions = {
  /** Open even if the store is marked read-only (Convex's `allow_read_only`): readers and migration tools. */
  allowReadOnly?: boolean;
};

/**
 * The verdict on a recorded layout version. The current one opens. An older one would be upgraded in place
 * if bunvex had an upgrade for it; it has none yet (DV-56: no in-place migrations for now), so it is
 * refused. A newer or unreadable one is refused.
 */
export function checkLayoutVersion(found: unknown, store: string) {
  if (found === LAYOUT_VERSION) return;
  if (typeof found !== "number" || !Number.isInteger(found) || found < 1)
    throw new LayoutError(
      `${store} records an unknown layout version (${JSON.stringify(found)}); this bunvex writes layout ${LAYOUT_VERSION}. It was not written by bunvex, or it is damaged`,
    );
  if (found > LAYOUT_VERSION)
    throw new LayoutError(
      `${store} was written by a newer bunvex (layout version ${found}); this bunvex reads layout ${LAYOUT_VERSION}. Run the newer bunvex, or open another store`,
    );
  throw new LayoutError(
    `${store} was written with layout version ${found}; this bunvex reads layout ${LAYOUT_VERSION} and has no upgrade from ${found} (no in-place migrations yet)`,
  );
}

/**
 * A store without a version record is bunvex's only if its tables have bunvex's columns: a store written
 * before PERSIST-01 C10 (the same layout, version 1, so it opens and gets its record), or an empty one. Any
 * other `documents` / `indexes` — Convex's own, or a stranger's — is refused, never written to.
 * `found` / `want`: per table, its columns as "name type", in any order (absent tables are left out).
 */
export function checkUnversionedTables(
  store: string,
  found: Record<string, string[]>,
  want: Record<string, string[]>,
  /** How the store names them: "table"/"columns", or "collection"/"fields" (MongoDB). */
  words: [string, string] = ["table", "columns"],
) {
  for (const [table, cols] of Object.entries(found)) {
    const expected = want[table];
    if (!expected) continue;
    const a = [...cols].sort().join(", ");
    if (a === [...expected].sort().join(", ")) continue;
    throw new LayoutError(
      `${store} is not a bunvex store: it has no layout version, and its ${words[0]} \`${table}\` has the ${words[1]} ${a || "(none)"}. Point bunvex at an empty database, or at one bunvex created`,
    );
  }
}

/** A version record as SQL stores keep it (JSON text in `persistence_globals.json_value`, as Convex's). */
export function decodeLayoutVersion(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return String(raw);
  }
}
