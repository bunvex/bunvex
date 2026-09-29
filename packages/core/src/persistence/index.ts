// The Persistence interface — the whole contract between the engine and wherever its bytes live
// (PERSIST-01, docs/specs/PERSIST-01-contract.md). The engine never looks past it: every driver (memory,
// SQLite, and the external ones in @bunvex/persistence) implements exactly this, and must pass
// @bunvex/persistence-conformance.

/** One document version. `json === null` is a delete. */
export type DocWrite = { table: number; id: string; json: string | null };
/** One index entry version. `id === null` means the entry was removed. `key` is opaque (keyenc bytes). */
export type IndexWrite = { index: number; key: Uint8Array; id: string | null };

export interface Persistence {
  /** Apply one commit's writes at `ts`. Called by the committer, possibly several times per group. */
  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]): void;
  /** Make every applied commit durable (one fsync for the whole group). May be async. */
  flush(): void | Promise<void>;
  /** Index range [lo, hi) as of `ts`: live document ids, in byte order of the key (reversed if `desc`),
   *  up to `limit`. Embedded drivers answer synchronously; remote ones return a promise. */
  scan(
    index: number,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: number,
    limit: number,
    desc: boolean,
  ): string[] | Promise<string[]>;
  /** The document version visible at `ts` (JSON), or null. */
  get(table: number, id: string, ts: number): string | null | Promise<string | null>;
  /** The highest durable commit ts (recovery on open). */
  maxTs?(): number | Promise<number>;
  /** AUDIT ONLY (conformance K6, never used by the engine): live documents of a table at ts. */
  auditLiveDocs?(table: number, ts: number): number | Promise<number>;
  close(): void | Promise<void>;
}

/** Optional fast path: the documents for what `scan` would return, in one round trip (PERSIST-01 C6). */
export interface ScanDocs {
  scanDocs(
    table: number,
    index: number,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: number,
    limit: number,
    desc: boolean,
  ): Promise<string[]>;
}
