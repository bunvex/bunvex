// Search index snapshots (STUDY-96; STUDY-79 §6 option D, owner 2026-10-04): at a clean shutdown the in-memory
// text and vector indexes are written out with the ts they are current at; at start each index is restored
// from it and brought up to date from the document log — every document the log changed since, at its
// current version — instead of read from its whole table. Convex reaches the same by replaying the writes
// since its last persisted segment (DV-227, DV-270's "persisted later").
//
// A snapshot is used only when it can be trusted: its format, the store it was written against (a token kept
// in the store's `search_snapshot` global), a ts not ahead of the store and still within document retention,
// and, per index, the same table and definition. Anything else rebuilds that index from its table, as before.
import { gunzipSync, gzipSync } from "node:zlib";
import type { IndexedDoc } from "@bunvex/search";
import type { DocLogRow, Persistence, RetentionStore } from "./persistence/index.ts";
import type { Doc, SearchIndexDef, VectorIndexDef } from "./schema.ts";
import type { SearchIndexEntry } from "./search-indexes.ts";
import type { Entry, VectorIndexEntry } from "./vector-indexes.ts";

const FORMAT = 1;
/** The store's global naming the snapshot written against it. */
export const SEARCH_SNAPSHOT_GLOBAL = "search_snapshot";
/** Retention's global for the oldest document snapshot it keeps (retention.ts). */
const MIN_DOCUMENT_TS_GLOBAL = "document_min_snapshot_ts";
const LOG_PAGE = 1000;
const VERSIONS_PAGE = 1000;

/** Where snapshots are kept (the server's `search` blob use case): blobs by the key `put` gives them. */
export type SearchSnapshotStore = {
  put(data: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};

/** The store's `search_snapshot` global: the snapshot written against it, by its blob's key. */
type Mark = { token: string; key: string };

type TextIndexSnapshot = { tablet: number; name: string; def: SearchIndexDef; docs: [string, IndexedDoc][] };
type VectorIndexSnapshot = {
  tablet: number;
  name: string;
  def: VectorIndexDef;
  /** Each document's normalised vector (its f32 bytes in base64) and filter keys. */
  docs: [string, string, Record<string, string>][];
};
export type SearchSnapshot = {
  format: number;
  token: string;
  ts: number;
  text: TextIndexSnapshot[];
  vector: VectorIndexSnapshot[];
};

type Store = Persistence & Pick<RetentionStore, "readDocumentLog" | "getGlobal" | "setGlobal">;

/** Whether the store has what restoring needs: the document log, versions and globals. */
export function canSnapshotSearch(p: Persistence): p is Store {
  const s = p as Partial<Store>;
  return (
    typeof s.readDocumentLog === "function" &&
    typeof s.getGlobal === "function" &&
    typeof s.setGlobal === "function" &&
    typeof p.getVersions === "function"
  );
}

const sameDef = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The ready indexes, as of `ts` (every commit up to it applied). */
export function buildSearchSnapshot(
  ts: number,
  token: string,
  text: SearchIndexEntry[],
  vector: VectorIndexEntry[],
): Uint8Array {
  const snapshot: SearchSnapshot = {
    format: FORMAT,
    token,
    ts,
    text: text
      .filter((e) => e.ready && !e.staged)
      .map((e) => ({
        tablet: e.tablet,
        name: e.name,
        def: e.def,
        docs: [...e.index.ids()].map((id) => [id, e.index.get(id)!] as [string, IndexedDoc]),
      })),
    vector: vector
      .filter((e) => e.ready && !e.staged)
      .map((e) => ({
        tablet: e.tablet,
        name: e.name,
        def: e.def,
        docs: [...e.index.ids()]
          .map((id) => [id, e.index.get(id)!] as const)
          .map(
            ([id, d]) =>
              [
                id,
                Buffer.from(d.vector.buffer, d.vector.byteOffset, d.vector.byteLength).toString("base64"),
                d.filters,
              ] as [string, string, Record<string, string>],
          ),
      })),
  };
  return gzipSync(JSON.stringify(snapshot));
}

/**
 * The snapshot to restore from, when it can be trusted against `store` at `at`; null otherwise (then every
 * index is read from its table).
 */
export async function loadSearchSnapshot(
  store: Store,
  blobs: SearchSnapshotStore,
  at: number,
): Promise<SearchSnapshot | null> {
  const mark = (await store.getGlobal(SEARCH_SNAPSHOT_GLOBAL)) as Partial<Mark> | null;
  if (typeof mark?.key !== "string" || typeof mark.token !== "string") return null;
  let s: SearchSnapshot;
  try {
    const data = await blobs.get(mark.key);
    if (!data) return null;
    s = JSON.parse(gunzipSync(data).toString("utf8")) as SearchSnapshot;
  } catch {
    return null;
  }
  if (s?.format !== FORMAT || s.token !== mark.token || !Number.isSafeInteger(s.ts) || s.ts > at) return null;
  if (s.ts < Number((await store.getGlobal(MIN_DOCUMENT_TS_GLOBAL)) ?? 0)) return null;
  return s;
}

/**
 * Write a snapshot of `text` and `vector` as of `ts`, then point the store's global at it and remove the one
 * it replaces. A crash between the two leaves the global at the old snapshot, still valid.
 */
export async function saveSearchSnapshot(
  store: Store,
  blobs: SearchSnapshotStore,
  ts: number,
  text: SearchIndexEntry[],
  vector: VectorIndexEntry[],
): Promise<void> {
  const token = crypto.randomUUID();
  const key = await blobs.put(buildSearchSnapshot(ts, token, text, vector));
  const old = (await store.getGlobal(SEARCH_SNAPSHOT_GLOBAL)) as Partial<Mark> | null;
  await store.setGlobal(SEARCH_SNAPSHOT_GLOBAL, { token, key } satisfies Mark);
  if (typeof old?.key === "string" && old.key !== key) await blobs.delete(old.key).catch(() => {});
}

/**
 * Restores indexes from a snapshot: an index's saved documents, then every document the log changed since
 * the snapshot, at `at`. The log is read once per table, however many of its indexes ask.
 */
export class SearchRestore {
  private changed = new Map<number, Promise<Map<string, Doc | null>>>();

  constructor(
    private store: Store,
    readonly snapshot: SearchSnapshot,
    private at: number,
    private decode: (json: string) => Doc,
  ) {}

  /** Each changed document of `tablet` since the snapshot, at `at` (null: deleted). */
  private changes(tablet: number): Promise<Map<string, Doc | null>> {
    let p = this.changed.get(tablet);
    if (!p) {
      p = this.read(tablet);
      this.changed.set(tablet, p);
    }
    return p;
  }

  private async read(tablet: number): Promise<Map<string, Doc | null>> {
    const ids = new Set<string>();
    for (let cursor = this.snapshot.ts; cursor < this.at; ) {
      const rows: DocLogRow[] = await this.store.readDocumentLog(cursor, this.at, LOG_PAGE);
      if (!rows.length) break;
      for (const r of rows) if (r.table === tablet) ids.add(r.id);
      cursor = rows[rows.length - 1]!.ts;
    }
    const out = new Map<string, Doc | null>();
    const list = [...ids];
    for (let i = 0; i < list.length; i += VERSIONS_PAGE) {
      const page = list.slice(i, i + VERSIONS_PAGE);
      const versions = await this.store.getVersions!(tablet, page, this.at);
      page.forEach((id, k) => {
        out.set(id, versions[k] ? this.decode(versions[k]!.json) : null);
      });
    }
    return out;
  }

  /** The text index from the snapshot; false when it has none for it (or a different definition). */
  async text(
    e: SearchIndexEntry,
    restore: (id: string, d: IndexedDoc | null) => void,
    index: (doc: Doc) => IndexedDoc,
  ): Promise<boolean> {
    const saved = this.snapshot.text.find((x) => x.tablet === e.tablet && x.name === e.name && sameDef(x.def, e.def));
    if (!saved) return false;
    for (const [id, d] of saved.docs) restore(id, d);
    for (const [id, doc] of await this.changes(e.tablet)) restore(id, doc ? index(doc) : null);
    return true;
  }

  /** The vector index from the snapshot; false when it has none for it (or a different definition). */
  async vector(
    e: VectorIndexEntry,
    restore: (id: string, entry: Entry | null) => void,
    entryOf: (doc: Doc) => Entry | null,
  ): Promise<boolean> {
    const saved = this.snapshot.vector.find((x) => x.tablet === e.tablet && x.name === e.name && sameDef(x.def, e.def));
    if (!saved) return false;
    for (const [id, vector, filters] of saved.docs) {
      const bytes = Buffer.from(vector, "base64");
      restore(id, { vector: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), filters });
    }
    for (const [id, doc] of await this.changes(e.tablet)) restore(id, doc ? entryOf(doc) : null);
    return true;
  }
}
