// The metadata a worker's transactions read, sent from the main thread (STUDY-194 §4.7, 2b commit 0d): the catalog and
// the text indexes' states, each numbered by the engine's `metadataEpoch`, and the commits' written keys, which the
// worker's index cache checks its entries against. In the call messages' format (`call-wire.ts`).
//
// Convex rebuilds each registry from the store at the request's timestamp instead (`BootstrapMetadata`,
// `TableRegistry` and `IndexRegistry` read through the snapshot); bunvex hands a worker the main thread's own, as a
// transaction begun in-thread takes it (§4.7).
import { Out, WireReader } from "./call-wire.ts";
import { Catalog } from "./catalog.ts";
import { type Interval, type LogEntry, WRITE_LOG_MIN_RETENTION_NS } from "./committer.ts";
import type { IndexDef, TableDef } from "./schema.ts";
import type { SearchIndexEntry, SearchIndexes, SearchIndexState } from "./search-indexes.ts";
import { intervalSetsByIndex, WritesByIndex } from "./write-log-index.ts";

// --- The catalog

/** The catalog as text: every namespace's tables, active, hidden and being deleted, and each index's state. */
export function encodeCatalog(c: Catalog): string {
  const w = new Out("k");
  writeCatalog(w, c);
  return w.s;
}

function writeCatalog(w: Out, c: Catalog) {
  for (const list of [c.tables.values(), c.hidden.values(), c.deleting.values()]) {
    const tables = [...list];
    w.num(tables.length);
    for (const t of tables) writeTable(w, t);
  }
  w.num(c.components.size);
  for (const [id, component] of c.components) {
    w.str(id);
    writeCatalog(w, component);
  }
}

function writeTable(w: Out, t: TableDef) {
  w.str(t.name);
  w.str(t.id);
  w.num(t.number);
  w.opt(t.metaId ?? null);
  w.opt(t.namespace ?? null);
  w.num(t.indexes.size);
  for (const ix of t.indexes.values()) writeIndex(w, ix);
  w.num(t.pending.length);
  for (const ix of t.pending) writeIndex(w, ix);
}

function writeIndex(w: Out, ix: IndexDef) {
  w.str(ix.id);
  w.str(ix.table);
  w.str(ix.name);
  w.num(ix.fields.length);
  for (const f of ix.fields) w.str(f);
  w.opt(ix.metaId ?? null);
  // Absent and false are two things to `IndexDef` (a copy keeps what it was given).
  w.num(ix.staged === undefined ? 0 : ix.staged ? 2 : 1);
  w.optNum(ix.readyTs ?? null);
}

export function decodeCatalog(s: string): Catalog {
  const r = new WireReader(s, "catalog");
  r.at("header");
  if (s[0] !== "k") r.fail(`expected "k", got ${JSON.stringify(s.slice(0, 1))}`);
  r.skip(1);
  const c = readCatalog(r, "");
  r.close();
  return c;
}

function readCatalog(r: WireReader, at: string): Catalog {
  const c = new Catalog();
  const lists = [
    ["tables", (t: TableDef) => c.tables.set(t.name, t)],
    ["hidden", (t: TableDef) => c.hidden.set(t.id, t)],
    ["deleting", (t: TableDef) => c.deleting.set(t.id, t)],
  ] as const;
  for (const [list, put] of lists) {
    r.at(`${at}${list}`);
    const n = r.count();
    for (let i = 0; i < n; i++) put(readTable(r, `${at}${list}`, i));
  }
  c.indexNumbers();
  r.at(`${at}components`);
  const n = r.count();
  for (let i = 0; i < n; i++) {
    r.item(`${at}components`, i, "id");
    const id = r.str();
    c.components.set(id, readCatalog(r, `${at}components[${i}].`));
  }
  return c;
}

function readTable(r: WireReader, list: string, i: number): TableDef {
  r.item(list, i, "");
  const name = r.str();
  const id = r.str();
  const number = r.int();
  const metaId = r.opt();
  const namespace = r.opt();
  r.item(list, i, "indexes");
  const indexes = new Map<string, IndexDef>();
  const enabled = r.count();
  for (let j = 0; j < enabled; j++) {
    const ix = readIndex(r);
    indexes.set(ix.name, ix);
  }
  r.item(list, i, "pending");
  const pending: IndexDef[] = new Array(r.count());
  for (let j = 0; j < pending.length; j++) pending[j] = readIndex(r);
  // As the catalog derives it: a table whose indexes a deletion or a disable left without one has none.
  const t: TableDef = { id, number, name, indexes, pending, byId: indexes.get("by_id") as IndexDef };
  if (metaId !== null) t.metaId = metaId;
  if (namespace !== null) t.namespace = namespace;
  return t;
}

function readIndex(r: WireReader): IndexDef {
  const id = r.str();
  const table = r.str();
  const name = r.str();
  const fields: string[] = new Array(r.count());
  for (let k = 0; k < fields.length; k++) fields[k] = r.str();
  const ix: IndexDef = { id, table, name, fields };
  const metaId = r.opt();
  if (metaId !== null) ix.metaId = metaId;
  const staged = r.int();
  if (staged > 2) r.fail(`expected 0, 1 or 2, got ${staged}`);
  if (staged) ix.staged = staged === 2;
  const readyTs = r.optBig();
  if (readyTs !== null) ix.readyTs = readyTs;
  return ix;
}

// --- The text indexes' states

/** What a transaction reads of a text index before it searches: its definition and state, not its contents. */
export type { SearchIndexState };

/** The text indexes' states as text: the active ones, then a pending push's. */
export function encodeSearchState(s: SearchIndexes): string {
  const w = new Out("x");
  for (const list of [s.all(), s.pendingAll()]) {
    w.num(list.length);
    for (const e of list) {
      w.str(e.readIndex);
      w.str(e.table);
      w.str(e.tablet);
      w.str(e.name);
      w.str(e.def.searchField);
      w.num(e.def.filterFields.length);
      for (const f of e.def.filterFields) w.str(f);
      w.num((e.staged ? 1 : 0) | (e.ready ? 2 : 0) | (e.bootstrapping ? 4 : 0));
    }
  }
  return w.s;
}

/** The text indexes' states a worker holds, answering as `SearchIndexes` does from them. */
export class SearchIndexStates {
  private readonly active = new Map<string, SearchIndexState>();
  private readonly pending = new Map<string, SearchIndexState>();
  private readonly byTablet = new Map<string, SearchIndexState[]>();

  constructor(active: SearchIndexState[], pending: SearchIndexState[]) {
    for (const e of active) {
      this.active.set(key(e.tablet, e.name), e);
      const list = this.byTablet.get(e.tablet);
      if (list) list.push(e);
      else this.byTablet.set(e.tablet, [e]);
    }
    for (const e of pending) this.pending.set(key(e.tablet, e.name), e);
  }

  /** As `SearchIndexes.get`: the active index, else a pending push's, as never ready. */
  get(t: TableDef, name: string): SearchIndexState | undefined {
    const k = key(t.id, name);
    const active = this.active.get(k);
    if (active) return active;
    const p = this.pending.get(k);
    return p && { ...p, ready: false, bootstrapping: false };
  }
  forTablet(tablet: string): readonly SearchIndexState[] {
    return this.byTablet.get(tablet) ?? [];
  }
  all(): SearchIndexState[] {
    return [...this.active.values()];
  }
  pendingAll(): SearchIndexState[] {
    return [...this.pending.values()];
  }
}

const key = (tablet: string, name: string) => `${tablet}\u0000${name}`;

export function decodeSearchState(s: string): SearchIndexStates {
  const r = new WireReader(s, "search state");
  r.at("header");
  if (s[0] !== "x") r.fail(`expected "x", got ${JSON.stringify(s.slice(0, 1))}`);
  r.skip(1);
  const lists: SearchIndexState[][] = [];
  for (const list of ["active", "pending"]) {
    r.at(list);
    const out: SearchIndexState[] = new Array(r.count());
    for (let i = 0; i < out.length; i++) {
      r.item(list, i, "");
      const readIndex = r.str();
      const table = r.str();
      const tablet = r.str();
      const name = r.str();
      const searchField = r.str();
      const filterFields: string[] = new Array(r.count());
      for (let j = 0; j < filterFields.length; j++) filterFields[j] = r.str();
      const flags = r.int();
      if (flags > 7) r.fail(`unknown flags ${flags}`);
      out[i] = {
        readIndex,
        table,
        tablet,
        name,
        def: { searchField, filterFields },
        staged: (flags & 1) !== 0,
        ready: (flags & 2) !== 0,
        bootstrapping: (flags & 4) !== 0,
      };
    }
    lists.push(out);
  }
  r.close();
  return new SearchIndexStates(lists[0]!, lists[1]!);
}

// --- One epoch's metadata, and the window of them

/** How many metadata epochs a worker keeps; the main thread counts the same, and sends again one that fell out. */
export const METADATA_EPOCHS_KEPT = 4;

/**
 * One epoch's metadata as a worker gets it, posted before the first request that names it. `schema`: the active
 * schemas a mutation's writes are validated by, as the engine's text (the app's and each component's), or null.
 */
export type Metadata = { epoch: number; catalog: Catalog; search: SearchIndexStates; schema: string | null };

export function encodeMetadata(
  epoch: number,
  catalog: Catalog,
  search: SearchIndexes,
  schema: string | null = null,
): string {
  const w = new Out("m");
  w.num(epoch);
  w.str(encodeCatalog(catalog));
  w.str(encodeSearchState(search));
  w.opt(schema);
  return w.s;
}

export function decodeMetadata(s: string): Metadata {
  const r = new WireReader(s, "metadata");
  r.at("header");
  if (s[0] !== "m") r.fail(`expected "m", got ${JSON.stringify(s.slice(0, 1))}`);
  r.skip(1);
  r.at("epoch");
  const epoch = r.int();
  r.at("catalog");
  const catalog = decodeCatalog(r.str());
  r.at("search");
  const search = decodeSearchState(r.str());
  r.at("schema");
  const schema = r.opt();
  r.close();
  return { epoch, catalog, search, schema };
}

/**
 * The main thread's side, one per worker: the epochs it sent that the worker still has, as the worker keeps them (the
 * last `METADATA_EPOCHS_KEPT`, in the order sent).
 */
// The sandbox's host keeps the same for its children (`packages/sandbox/src/host-call.ts`, `EpochWindow`).
export class EpochWindow {
  private readonly sent: number[] = [];
  has(epoch: number): boolean {
    return this.sent.includes(epoch);
  }
  add(epoch: number) {
    this.sent.push(epoch);
    if (this.sent.length > METADATA_EPOCHS_KEPT) this.sent.shift();
  }
}

/** The worker's side: the last `METADATA_EPOCHS_KEPT` epochs' metadata it was sent. */
export class MetadataCopies {
  private readonly kept = new Map<number, Metadata>();
  hear(m: Metadata) {
    this.kept.delete(m.epoch);
    this.kept.set(m.epoch, m);
    if (this.kept.size > METADATA_EPOCHS_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }
  /** An epoch's metadata; a request names only one sent before it, and still kept. */
  get(epoch: number): Metadata {
    const m = this.kept.get(epoch);
    if (!m) throw new Error(`metadata epoch ${epoch} was not sent, or no longer kept`);
    return m;
  }
}

// --- The commits

/** A commit as a worker's index cache checks against it: its ts and the keys it wrote, by index. */
export type CommitKeys = Pick<LogEntry, "ts" | "writes">;

/**
 * The commits a worker has not heard of, oldest first, with where the main thread's write log stands: its visible ts
 * (past the last commit, if one wrote nothing) and the oldest ts it still proves from (`purgedTs`). A worker's copy
 * forgets what the main thread's forgot.
 */
export type CommitsMessage = { visibleTs: bigint; purgedTs: bigint; entries: readonly CommitKeys[] };

export function encodeCommits(m: CommitsMessage): string {
  const w = new Out("w");
  w.num(m.visibleTs);
  w.num(m.purgedTs);
  w.num(m.entries.length);
  for (const e of m.entries) {
    w.num(e.ts);
    w.num(e.writes.length);
    for (const x of e.writes) {
      w.str(x.index);
      w.bytes(x.key);
    }
  }
  return w.s;
}

export function decodeCommits(s: string): { visibleTs: bigint; purgedTs: bigint; entries: LogEntry[] } {
  const r = new WireReader(s, "commits");
  r.at("header");
  if (s[0] !== "w") r.fail(`expected "w", got ${JSON.stringify(s.slice(0, 1))}`);
  r.skip(1);
  r.at("visibleTs");
  const visibleTs = r.big();
  r.at("purgedTs");
  const purgedTs = r.big();
  r.at("entries");
  const entries: LogEntry[] = new Array(r.count());
  for (let i = 0; i < entries.length; i++) {
    r.item("entries", i, "ts");
    const ts = r.big();
    r.item("entries", i, "writes");
    const writes: LogEntry["writes"] = new Array(r.count());
    for (let j = 0; j < writes.length; j++) {
      r.item("entries", i, `writes[${j}]`);
      writes[j] = { index: r.str(), key: r.bytes(), id: null };
    }
    entries[i] = { ts, writes };
  }
  r.close();
  return { visibleTs, purgedTs, entries };
}

/**
 * The main thread's write log as a worker hears it, for its index cache: an entry cached at one ts is good at another
 * when no commit in between wrote into it (`Committer.changedBetween`, answered the same way from the same commits).
 *
 * It keeps less than the main thread's log: the commits of the last `keepNs` (the write log's minimum retention, 30 s
 * by default), where the main thread keeps up to its maximum (300 s), for its conflicts and subscriptions. A worker
 * needs it only for its index cache, whose entries move to the ts of each hit: one read within the window stays a
 * hit, and one older is read again. A copy of the whole log in every worker was most of their memory under a steady
 * write load (the soak's R1, 2026-11-13).
 */
export class WriteLogCopy {
  visibleTs: bigint;
  private purgedTs: bigint;
  private readonly log: LogEntry[] = [];
  private head = 0;
  private readonly byIndex = new WritesByIndex();

  /** From the main thread's visible ts when the worker started: nothing before it can be proven. */
  constructor(
    startTs: bigint,
    private readonly keepNs: bigint = WRITE_LOG_MIN_RETENTION_NS,
  ) {
    this.visibleTs = this.purgedTs = startTs;
  }

  /** A `commits` message, in the order the main thread posted them: the commits it had not heard of. */
  hear(text: string): LogEntry[] {
    const m = decodeCommits(text);
    const fresh: LogEntry[] = [];
    for (const e of m.entries) {
      if (e.ts <= this.visibleTs) continue;
      this.log.push(e);
      this.byIndex.append(e);
      this.visibleTs = e.ts;
      fresh.push(e);
    }
    if (m.visibleTs > this.visibleTs) this.visibleTs = m.visibleTs;
    // What the main thread dropped, or what is older than this copy keeps: every commit above it stays.
    const kept = this.visibleTs - this.keepNs;
    let purgedTs = m.purgedTs;
    if (kept > purgedTs) purgedTs = kept;
    if (purgedTs > this.purgedTs) {
      this.purgedTs = purgedTs;
      while (this.head < this.log.length && this.log[this.head]!.ts <= purgedTs) {
        this.byIndex.removeOldest(this.log[this.head]!);
        this.log[this.head++] = undefined as unknown as LogEntry;
      }
      if (this.head > 1024 && this.head * 2 > this.log.length) {
        this.log.splice(0, this.head);
        this.head = 0;
      }
    }
    return fresh;
  }

  changedBetween(reads: Interval[], from: bigint, to: bigint): boolean {
    if (to > this.visibleTs) throw new Error(`changedBetween: ${to} is past the visible ts ${this.visibleTs}`);
    if (from >= to) return false;
    if (from < this.purgedTs) return true;
    if (reads.length === 0) return false;
    return this.byIndex.conflict(intervalSetsByIndex(reads), from, to, noSource) !== null;
  }
}

const noSource = (): undefined => undefined;
