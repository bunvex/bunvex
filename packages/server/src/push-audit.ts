// What a push changed, for its `push_config_with_components` audit-log event (STUDY-48 follow-up, DV-276):
// the index diff between the active schema and the pushed one, as Convex's `get_full_index_diff` and its
// `DeveloperIndexConfig` entries, and the auth providers added and removed, each as Convex's JSON string.
import type { DeclaredTable, SchemaDefinition } from "@bunvex/core";
import type { Value } from "@bunvex/values";

type IndexEntry = { key: string; config: Record<string, Value> };

/** Every index of a schema (database, search, vector) as Convex's `SerializedNamedDeveloperIndexConfig`. */
function indexesOf(schema: SchemaDefinition): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  for (const t of schema.tables.values() as Iterable<DeclaredTable>) {
    const staged = (names?: string[]) => new Set(names ?? []);
    const db = staged(t.staged);
    for (const [n, fields] of Object.entries(t.indexes)) {
      // As `_index` holds them (Convex's `IndexedFields`): a user index ends with `_creationTime`.
      const spec = { type: "database", fields: t.name.startsWith("_") ? [...fields] : [...fields, "_creationTime"] };
      out.set(`${t.name}.${n}`, {
        key: JSON.stringify(spec),
        config: { name: `${t.name}.${n}`, ...spec, staged: db.has(n) },
      });
    }
    const search = staged(t.stagedSearch);
    for (const [n, d] of Object.entries(t.searchIndexes ?? {})) {
      const spec = { type: "search", searchField: d.searchField, filterFields: [...d.filterFields].sort() };
      out.set(`${t.name}.${n}`, {
        key: JSON.stringify(spec),
        config: { name: `${t.name}.${n}`, ...spec, staged: search.has(n) },
      });
    }
    const vector = staged(t.stagedVector);
    for (const [n, d] of Object.entries(t.vectorIndexes ?? {})) {
      const spec = {
        type: "vector",
        vectorField: d.vectorField,
        filterFields: [...d.filterFields].sort(),
        dimensions: BigInt(d.dimensions),
      };
      out.set(`${t.name}.${n}`, {
        key: JSON.stringify(spec, (_, x) => (typeof x === "bigint" ? x.toString() : x)),
        config: { name: `${t.name}.${n}`, ...spec, staged: vector.has(n) },
      });
    }
  }
  return out;
}

/**
 * The indexes a push adds, removes, enables (a staged one no longer staged) and disables (staged again); an
 * index whose definition changed is removed and added.
 */
export function indexAuditDiff(before: SchemaDefinition, after: SchemaDefinition) {
  const a = indexesOf(before);
  const b = indexesOf(after);
  const diff = {
    added_indexes: [] as Value[],
    removed_indexes: [] as Value[],
    enabled_indexes: [] as Value[],
    disabled_indexes: [] as Value[],
  };
  for (const [name, x] of b) {
    const old = a.get(name);
    if (!old || old.key !== x.key) {
      diff.added_indexes.push(x.config);
      if (old) diff.removed_indexes.push(old.config);
    } else if (old.config.staged && !x.config.staged) diff.enabled_indexes.push(x.config);
    else if (!old.config.staged && x.config.staged) diff.disabled_indexes.push(x.config);
  }
  for (const [name, x] of a) if (!b.has(name)) diff.removed_indexes.push(x.config);
  return diff;
}

/**
 * The same diff as a push answers it (`start_push`'s `schemaChange.indexDiffs` and `finish_push`'s
 * `componentDiffs[""].indexDiff`, Convex's `SerializedIndexDiff`): each index a
 * `SerializedNamedDeveloperIndexConfig` in JSON, so `dimensions` is a number.
 */
export function indexDiffJson(diff: ReturnType<typeof indexAuditDiff>) {
  const json = (list: Value[]) =>
    list.map((c) =>
      Object.fromEntries(
        Object.entries(c as Record<string, Value>).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]),
      ),
    );
  return {
    added_indexes: json(diff.added_indexes),
    removed_indexes: json(diff.removed_indexes),
    enabled_indexes: json(diff.enabled_indexes),
    disabled_indexes: json(diff.disabled_indexes),
  };
}
